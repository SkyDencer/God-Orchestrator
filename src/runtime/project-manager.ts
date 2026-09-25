import Database from 'better-sqlite3';
import { EventStore } from './event-store.js';
import { StateMachine } from './state-machine.js';
import { ProjectState } from './states.js';

export interface CreateProjectInput {
  name: string;
  rootPath: string;
  specificationPath: string;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  specificationPath: string;
  status: ProjectState;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  specification_path: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Specification {
  id: number;
  content: string;
  hash: string;
  version: number;
  isOriginal: boolean;
  createdAt: Date;
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS project_manager (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    specification_path TEXT NOT NULL,
    status TEXT DEFAULT 'CREATED',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

const CREATE_SPECS_TABLE = `
  CREATE TABLE IF NOT EXISTS project_specifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    content TEXT NOT NULL,
    hash TEXT NOT NULL,
    version INTEGER NOT NULL,
    is_original INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES project_manager(id)
  );
`;

export class ProjectManager {
  private readonly db: Database.Database;
  private readonly eventStore: EventStore;
  private readonly stateMachine: StateMachine<ProjectState>;

  // Statements
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly updateStatusStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly softDeleteStmt: Database.Statement;
  private readonly insertSpecStmt: Database.Statement;
  private readonly getSpecsStmt: Database.Statement;

  constructor(
    db: Database.Database,
    eventStore: EventStore,
    stateMachine: StateMachine<ProjectState>,
  ) {
    this.db = db;
    this.eventStore = eventStore;
    this.stateMachine = stateMachine;

    db.exec(CREATE_TABLE);
    db.exec(CREATE_SPECS_TABLE);

    this.insertStmt = db.prepare(`
      INSERT INTO project_manager (id, name, root_path, specification_path, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.getByIdStmt = db.prepare('SELECT * FROM project_manager WHERE id = ?');

    this.updateStatusStmt = db.prepare(`
      UPDATE project_manager SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);

    this.listStmt = db.prepare('SELECT * FROM project_manager ORDER BY created_at DESC');

    this.softDeleteStmt = db.prepare(`
      UPDATE project_manager SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);

    this.insertSpecStmt = db.prepare(`
      INSERT INTO project_specifications (project_id, content, hash, version, is_original, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    this.getSpecsStmt = db.prepare(`
      SELECT * FROM project_specifications WHERE project_id = ? ORDER BY version ASC
    `);
  }

  /**
   * Create a new project with original spec version 1 (INV-07).
   */
  create(input: CreateProjectInput): Project {
    const id = this.generateProjectId(input.name);
    const now = new Date().toISOString();

    this.insertStmt.run(
      id,
      input.name,
      input.rootPath,
      input.specificationPath,
      ProjectState.CREATED,
      now,
      now,
    );

    // Store original specification (version 1) - INV-07
    const originalContent = `[Original specification for ${input.name}]`;
    const originalHash = this.computeHash(originalContent);
    this.insertSpecStmt.run(id, originalContent, originalHash, 1, 1);

    // Append project.created event
    this.eventStore.append({
      type: 'project.created',
      projectId: id,
      actor: 'system',
      payload: input,
    });

    return this.getRowById(id)!;
  }

  /**
   * Get a project by ID.
   */
  get(id: string): Project | null {
    const row = this.getByIdStmt.get(id) as ProjectRow | undefined;
    return row ? this.mapRowToProject(row) : null;
  }

  /**
   * List all projects.
   */
  list(): Project[] {
    const rows = this.listStmt.all() as ProjectRow[];
    return rows.map((r) => this.mapRowToProject(r));
  }

  /**
   * Update project status with state machine validation.
   */
  updateStatus(id: string, newStatus: ProjectState): Project {
    const project = this.get(id);
    if (!project) {
      throw new Error(`Project ${id} not found`);
    }

    this.stateMachine.validateTransition(project.status, newStatus);

    this.updateStatusStmt.run(newStatus, id);

    // Append status changed event
    this.eventStore.append({
      type: 'project.status_changed',
      projectId: id,
      actor: 'system',
      payload: { from: project.status, to: newStatus },
    });

    return this.get(id)!;
  }

  /**
   * Soft delete a project (sets status to CANCELLED).
   */
  delete(id: string): void {
    const project = this.get(id);
    if (!project) {
      throw new Error(`Project ${id} not found`);
    }

    this.softDeleteStmt.run(id);

    // Append deleted event
    this.eventStore.append({
      type: 'project.deleted',
      projectId: id,
      actor: 'system',
      payload: { previousStatus: project.status },
    });
  }

  /**
   * Get all specifications for a project.
   */
  getSpecification(projectId: string): Specification[] {
    const rows = this.getSpecsStmt.all(projectId) as Array<{
      id: number;
      content: string;
      hash: string;
      version: number;
      is_original: number;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      hash: r.hash,
      version: r.version,
      isOriginal: r.is_original === 1,
      createdAt: new Date(r.created_at),
    }));
  }

  /**
   * Add a new specification version. Original (version 1) is preserved.
   */
  addSpecification(projectId: string, content: string): { version: number; hash: string } {
    const project = this.get(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const hash = this.computeHash(content);
    const currentVersion = this.getCurrentVersion(projectId);
    const newVersion = currentVersion + 1;

    this.insertSpecStmt.run(projectId, content, hash, newVersion, 0);

    return { version: newVersion, hash };
  }

  /**
   * Get the original specification for a project.
   */
  getOriginalSpecification(projectId: string): Specification | null {
    const rows = this.db.prepare(
      'SELECT * FROM project_specifications WHERE project_id = ? AND is_original = 1 LIMIT 1',
    ).all() as Array<{
      id: number;
      content: string;
      hash: string;
      version: number;
      is_original: number;
      created_at: string;
    }>;

    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id,
      content: r.content,
      hash: r.hash,
      version: r.version,
      isOriginal: true,
      createdAt: new Date(r.created_at),
    };
  }

  private generateProjectId(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    }
    return `proj-${Math.abs(hash).toString(36)}`;
  }

  private getCurrentVersion(projectId: string): number {
    const row = this.db.prepare(
      'SELECT MAX(version) as max_version FROM project_specifications WHERE project_id = ?',
    ).get(projectId) as { max_version: number } | undefined;
    return row?.max_version ?? 0;
  }

  private computeHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
    }
    return `hash-${Math.abs(hash).toString(36)}`;
  }

  private mapRowToProject(row: ProjectRow): Project {
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      specificationPath: row.specification_path,
      status: row.status as ProjectState,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private getRowById(id: string): Project | null {
    const row = this.getByIdStmt.get(id) as ProjectRow | undefined;
    return row ? this.mapRowToProject(row) : null;
  }
}
