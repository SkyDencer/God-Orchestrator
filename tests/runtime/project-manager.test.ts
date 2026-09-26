import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { EventStore } from '../../src/runtime/event-store.js';
import { StateMachine } from '../../src/runtime/state-machine.js';
import { PROJECT_TRANSITIONS } from '../../src/runtime/transitions.js';
import { ProjectState } from '../../src/runtime/states.js';
import { ProjectManager } from '../../src/runtime/project-manager.js';

describe('ProjectManager', () => {
  let db: Database.Database;
  let eventStore: EventStore;
  let stateMachine: StateMachine<ProjectState>;
  let pm: ProjectManager;
  let tmpPath: string;

  beforeAll(() => {
    tmpPath = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-test-'),
    );
    const dbPath = path.join(tmpPath, 'pm-test.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create transitions table for atomic operations
    db.exec(`
      CREATE TABLE IF NOT EXISTS transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        triggered_by TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    eventStore = new EventStore(db);
    stateMachine = new StateMachine<ProjectState>('project', PROJECT_TRANSITIONS);
    pm = new ProjectManager(db, eventStore, stateMachine);
  });

  afterAll(() => {
    pm = null as unknown as ProjectManager;
    db.close();
    fs.rmSync(tmpPath, { recursive: true, force: true });
  });

  it('creates a project with CREATED status', () => {
    const project = pm.create({
      name: 'Test Project',
      rootPath: '/tmp/test',
      specificationPath: '/tmp/spec.json',
    });

    expect(project.id).toBeDefined();
    expect(project.name).toBe('Test Project');
    expect(project.status).toBe(ProjectState.CREATED);
    expect(project.rootPath).toBe('/tmp/test');
    expect(project.specificationPath).toBe('/tmp/spec.json');
  });

  it('create appends project.created event', () => {
    const project = pm.create({
      name: 'Event Project',
      rootPath: '/tmp/event',
      specificationPath: '/tmp/spec.json',
    });

    const events = eventStore.getByProject(project.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe('project.created');
    expect(events[0].projectId).toBe(project.id);
  });

  it('valid status update succeeds', () => {
    const project = pm.create({
      name: 'Status Project',
      rootPath: '/tmp/status',
      specificationPath: '/tmp/spec.json',
    });

    // CREATED → ANALYZING is valid
    const updated = pm.updateStatus(project.id, ProjectState.ANALYZING);
    expect(updated.status).toBe(ProjectState.ANALYZING);
  });

  it('invalid status update throws', () => {
    const project = pm.create({
      name: 'Invalid Project',
      rootPath: '/tmp/invalid',
      specificationPath: '/tmp/spec.json',
    });

    // CREATED → COMPLETED is invalid
    expect(() => pm.updateStatus(project.id, ProjectState.COMPLETED)).toThrow();
  });

  it('addSpecification creates version 2 while preserving original', () => {
    const project = pm.create({
      name: 'Spec Project',
      rootPath: '/tmp/spec-proj',
      specificationPath: '/tmp/spec.json',
    });

    // First spec (original, version 1) should have been created during project creation
    const specs = pm.getSpecification(project.id);
    expect(specs.length).toBe(1);
    expect(specs[0].version).toBe(1);
    expect(specs[0].isOriginal).toBe(true);

    // Add a new specification
    const result = pm.addSpecification(project.id, 'New specification content');
    expect(result.version).toBe(2);
    expect(result.hash).toBeDefined();

    // Verify original is still there
    const allSpecs = pm.getSpecification(project.id);
    expect(allSpecs.length).toBe(2);
    expect(allSpecs[0].isOriginal).toBe(true);
    expect(allSpecs[1].version).toBe(2);
  });

  it('getSpecification returns all versions', () => {
    const project = pm.create({
      name: 'MultiSpec Project',
      rootPath: '/tmp/multi',
      specificationPath: '/tmp/spec.json',
    });

    pm.addSpecification(project.id, 'Version 2');
    pm.addSpecification(project.id, 'Version 3');

    const specs = pm.getSpecification(project.id);
    expect(specs.length).toBe(3);
  });

  it('delete sets project to CANCELLED', () => {
    const project = pm.create({
      name: 'Delete Project',
      rootPath: '/tmp/delete',
      specificationPath: '/tmp/spec.json',
    });

    pm.delete(project.id);

    const deleted = pm.get(project.id);
    expect(deleted!.status).toBe(ProjectState.CANCELLED);
  });

  it('list returns all projects', () => {
    // Create fresh manager for isolated test
    const freshDb = new Database(path.join(tmpPath, 'list-test.db'));
    freshDb.pragma('journal_mode = WAL');
    const freshEventStore = new EventStore(freshDb);
    const freshStateMachine = new StateMachine<ProjectState>('project', PROJECT_TRANSITIONS);
    const freshPm = new ProjectManager(freshDb, freshEventStore, freshStateMachine);

    freshPm.create({ name: 'List 1', rootPath: '/tmp/1', specificationPath: '/tmp/s1.json' });
    freshPm.create({ name: 'List 2', rootPath: '/tmp/2', specificationPath: '/tmp/s2.json' });

    const projects = freshPm.list();
    expect(projects.length).toBe(2);

    freshDb.close();
  });

  it('get returns null for non-existent project', () => {
    const project = pm.get('non-existent-id');
    expect(project).toBeNull();
  });
});
