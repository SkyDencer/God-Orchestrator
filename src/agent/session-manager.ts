import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { EventStore } from '../runtime/event-store.js'
import type { AgentSession } from './types.js'

export type SessionStatus =
  | 'starting'
  | 'active'
  | 'ended'
  | 'crashed'
  | 'timeout'
  | 'stopped'

const SESSION_TRANSITIONS: Map<SessionStatus, SessionStatus[]> = new Map([
  ['starting', ['active', 'crashed', 'stopped']],
  ['active', ['ended', 'crashed', 'timeout', 'stopped']],
  ['ended', []],
  ['crashed', []],
  ['timeout', []],
  ['stopped', []],
])

function isValidTransition(from: SessionStatus, to: SessionStatus): boolean {
  const allowed = SESSION_TRANSITIONS.get(from)
  if (!allowed) return false
  return allowed.includes(to)
}

export interface SessionManagerDeps {
  db: Database.Database
  eventStore: EventStore
}

export class SessionManager {
  private readonly db: Database.Database
  private readonly eventStore: EventStore

  private readonly createStmt: Database.Statement
  private readonly getByIdStmt: Database.Statement
  private readonly getByPhaseStmt: Database.Statement
  private readonly updateStatusStmt: Database.Statement
  private readonly insertEventStmt: Database.Statement

  constructor(deps: SessionManagerDeps) {
    this.db = deps.db
    this.eventStore = deps.eventStore

    // Ensure agent_sessions table exists (migration may not cover all schema variants)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        phase_id TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT DEFAULT 'starting',
        process_id TEXT,
        started_at DATETIME NOT NULL,
        ended_at DATETIME,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    this.createStmt = this.db.prepare(`
      INSERT INTO agent_sessions
        (session_id, project_id, phase_id, attempt, status, started_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    this.getByIdStmt = this.db.prepare(`
      SELECT * FROM agent_sessions WHERE session_id = ?
    `)

    this.getByPhaseStmt = this.db.prepare(`
      SELECT * FROM agent_sessions WHERE phase_id = ? ORDER BY started_at DESC
    `)

    this.updateStatusStmt = this.db.prepare(`
      UPDATE agent_sessions
      SET status = ?, ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `)

    this.insertEventStmt = this.db.prepare(`
      INSERT INTO events (phase_id, event_type, event_data, timestamp)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `)
  }

  /**
   * Create a new session and persist it. Emits a session.created event.
   */
  create(session: AgentSession): AgentSession {
    const startedAt = new Date(session.startedAt).toISOString()
    this.createStmt.run(
      session.id,
      session.projectId,
      session.phaseId,
      session.attempt,
      session.status,
      startedAt,
      JSON.stringify(session.metadata),
    )

    // Emit event via event store
    this.eventStore.append({
      type: 'agent.session.created',
      actor: 'session-manager',
      payload: {
        sessionId: session.id,
        projectId: session.projectId,
        phaseId: session.phaseId,
        attempt: session.attempt,
      },
    })

    return this.get(session.id)!
  }

  /**
   * Get a session by ID. Returns null if not found.
   */
  get(id: string): AgentSession | null {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return this.mapRowToSession(row)
  }

  /**
   * Get all sessions for a phase, ordered newest first.
   */
  getByPhase(phaseId: string): AgentSession[] {
    const rows = this.getByPhaseStmt.all(phaseId) as Record<string, unknown>[]
    return rows.map((r) => this.mapRowToSession(r))
  }

  /**
   * Update session status with state machine validation.
   * Optionally merges additional metadata.
   */
  updateStatus(id: string, status: SessionStatus, meta?: Record<string, unknown>): void {
    const existing = this.get(id)
    if (!existing) {
      throw new Error(`Session ${id} not found`)
    }

    const currentStatus = existing.status as SessionStatus
    if (!isValidTransition(currentStatus, status)) {
      throw new Error(
        `Invalid transition from ${currentStatus} to ${status} for session ${id}`,
      )
    }

    this.updateStatusStmt.run(status, id)

    // Merge metadata if provided
    if (meta) {
      const merged = { ...existing.metadata, ...meta }
      this.db.prepare(
        'UPDATE agent_sessions SET metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
      ).run(JSON.stringify(merged), id)
    }

    // Emit event
    this.eventStore.append({
      type: 'agent.session.status_changed',
      actor: 'session-manager',
      payload: {
        sessionId: id,
        from: currentStatus,
        to: status,
      },
    })
  }

  /**
   * Gateway-level context reconstruction: reads working dir files.
   * Returns a list of file paths and their contents.
   */
  reconstructContext(sessionId: string): {
    files: string[]
    contents: Record<string, string>
  } {
    const session = this.get(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const workingDir = (session.metadata.workingDir as string) ?? process.cwd()
    const result: { files: string[]; contents: Record<string, string> } = {
      files: [],
      contents: {},
    }

    try {
      const entries = fs.readdirSync(workingDir, { recursive: true }) as string[]
      for (const entry of entries) {
        const fullPath = path.join(workingDir, entry)
        const stat = fs.statSync(fullPath)
        if (stat.isFile()) {
          const relativePath = path.relative(workingDir, fullPath)
          result.files.push(relativePath)
          try {
            result.contents[relativePath] = fs.readFileSync(fullPath, 'utf8')
          } catch {
            // Skip files that can't be read
          }
        }
      }
    } catch {
      // Working directory may not exist yet (e.g. session just starting)
    }

    return result
  }

  /**
   * Close a session: set status to 'ended' and record endedAt.
   * Validates state transition.
   */
  close(id: string, status: SessionStatus = 'ended'): void {
    this.updateStatus(id, status)
  }

  private mapRowToSession(row: Record<string, unknown>): AgentSession {
    return {
      id: row.session_id as string,
      projectId: row.project_id as string,
      phaseId: row.phase_id as string,
      attempt: row.attempt as number,
      status: (row.status as SessionStatus) ?? 'starting',
      processId: (row.process_id as string) ?? undefined,
      startedAt: new Date(row.started_at as string).getTime(),
      endedAt: row.ended_at
        ? new Date(row.ended_at as string).getTime()
        : undefined,
      metadata: row.metadata
        ? JSON.parse(row.metadata as string)
        : {},
    }
  }
}
