import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { EventStore } from '../../src/runtime/event-store.js'
import { SessionManager } from '../../src/agent/session-manager.js'
import type { AgentSession } from '../../src/agent/types.js'

describe('SessionManager', () => {
  let db: Database.Database
  let eventStore: EventStore
  let sm: SessionManager
  let tmpPath: string

  beforeAll(() => {
    tmpPath = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-test-'),
    )
    const dbPath = path.join(tmpPath, 'session-manager-test.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    // Create required tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS events_store (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        project_id TEXT,
        entity_type TEXT,
        entity_id TEXT,
        actor TEXT NOT NULL,
        payload TEXT NOT NULL,
        correlation_id TEXT,
        causation_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_events_project ON events_store(project_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events_store(type);
      CREATE INDEX IF NOT EXISTS idx_events_correlation ON events_store(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events_store(created_at);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phase_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        event_data TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `)

    eventStore = new EventStore(db)
    sm = new SessionManager({ db, eventStore })
  })

  afterAll(() => {
    db.close()
    fs.rmSync(tmpPath, { recursive: true, force: true })
  })

  it('create inserts a DB record and returns it', () => {
    const session: AgentSession = {
      id: randomUUID(),
      projectId: 'proj-1',
      phaseId: 'ph-1',
      attempt: 1,
      status: 'starting',
      startedAt: Date.now(),
      metadata: { workingDir: '/tmp/test' },
    }

    const created = sm.create(session)
    expect(created.id).toBe(session.id)
    expect(created.projectId).toBe('proj-1')
    expect(created.phaseId).toBe('ph-1')
    expect(created.attempt).toBe(1)
    expect(created.status).toBe('starting')
    expect(created.startedAt).toBeGreaterThan(0)
  })

  it('get returns stored session', () => {
    const id = randomUUID()
    sm.create({
      id,
      projectId: 'proj-2',
      phaseId: 'ph-2',
      attempt: 1,
      status: 'active',
      startedAt: Date.now(),
      metadata: {},
    })

    const found = sm.get(id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(id)
    expect(found!.projectId).toBe('proj-2')
  })

  it('get returns null for nonexistent session', () => {
    expect(sm.get('nonexistent-id')).toBeNull()
  })

  it('getByPhase returns sessions for a phase', () => {
    const t1 = Date.now() - 2000
    sm.create({
      id: randomUUID(),
      projectId: 'proj-3',
      phaseId: 'ph-3',
      attempt: 1,
      status: 'active',
      startedAt: t1,
      metadata: {},
    })
    const t2 = Date.now()
    sm.create({
      id: randomUUID(),
      projectId: 'proj-3',
      phaseId: 'ph-3',
      attempt: 2,
      status: 'ended',
      startedAt: t2,
      metadata: {},
    })

    const sessions = sm.getByPhase('ph-3')
    expect(sessions).toHaveLength(2)
    // Newest first (t2 > t1)
    expect(sessions[0].attempt).toBe(2)
    expect(sessions[1].attempt).toBe(1)
  })

  it('updateStatus transitions via state machine', () => {
    const id = randomUUID()
    sm.create({
      id,
      projectId: 'proj-4',
      phaseId: 'ph-4',
      attempt: 1,
      status: 'starting',
      startedAt: Date.now(),
      metadata: {},
    })

    // Valid: starting -> active
    sm.updateStatus(id, 'active')
    const active = sm.get(id)
    expect(active!.status).toBe('active')

    // Valid: active -> ended
    sm.updateStatus(id, 'ended')
    const ended = sm.get(id)
    expect(ended!.status).toBe('ended')
  })

  it('updateStatus rejects invalid transition', () => {
    const id = randomUUID()
    sm.create({
      id,
      projectId: 'proj-5',
      phaseId: 'ph-5',
      attempt: 1,
      status: 'active',
      startedAt: Date.now(),
      metadata: {},
    })

    // active -> starting is invalid
    expect(() => sm.updateStatus(id, 'starting')).toThrow(
      'Invalid transition from active to starting',
    )
  })

  it('updateStatus with metadata merges fields', () => {
    const id = randomUUID()
    sm.create({
      id,
      projectId: 'proj-6',
      phaseId: 'ph-6',
      attempt: 1,
      status: 'starting',
      startedAt: Date.now(),
      metadata: { existing: 'value' },
    })

    sm.updateStatus(id, 'active', { newKey: 'newValue' })
    const session = sm.get(id)
    expect(session!.metadata.existing).toBe('value')
    expect(session!.metadata.newKey).toBe('newValue')
  })

  it('reconstructContext reads working dir files', async () => {
    const testDir = fs.mkdtempSync(path.join(tmpPath, 'ctx-test-'))
    fs.writeFileSync(path.join(testDir, 'a.txt'), 'hello')
    fs.writeFileSync(path.join(testDir, 'b.md'), 'world')

    const id = randomUUID()
    sm.create({
      id,
      projectId: 'proj-7',
      phaseId: 'ph-7',
      attempt: 1,
      status: 'active',
      startedAt: Date.now(),
      metadata: { workingDir: testDir },
    })

    const ctx = sm.reconstructContext(id)
    expect(ctx.files).toContain('a.txt')
    expect(ctx.files).toContain('b.md')
    expect(ctx.contents['a.txt']).toBe('hello')
    expect(ctx.contents['b.md']).toBe('world')

    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('reconstructContext handles nonexistent working dir', () => {
    const id = randomUUID()
    sm.create({
      id,
      projectId: 'proj-8',
      phaseId: 'ph-8',
      attempt: 1,
      status: 'active',
      startedAt: Date.now(),
      metadata: { workingDir: '/nonexistent/path/xyz' },
    })

    const ctx = sm.reconstructContext(id)
    expect(ctx.files).toHaveLength(0)
    expect(ctx.contents).toEqual({})
  })

  it('close sets endedAt and transitions to ended', () => {
    const id = randomUUID()
    sm.create({
      id,
      projectId: 'proj-9',
      phaseId: 'ph-9',
      attempt: 1,
      status: 'active',
      startedAt: Date.now(),
      metadata: {},
    })

    sm.close(id, 'ended')
    const session = sm.get(id)
    expect(session!.status).toBe('ended')
    expect(session!.endedAt).toBeDefined()
    expect(session!.endedAt).toBeGreaterThan(0)
  })

  it('close with default status sets ended', () => {
    const id = randomUUID()
    sm.create({
      id,
      projectId: 'proj-10',
      phaseId: 'ph-10',
      attempt: 1,
      status: 'active',
      startedAt: Date.now(),
      metadata: {},
    })

    sm.close(id)
    const session = sm.get(id)
    expect(session!.status).toBe('ended')
  })
})
