import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';

export class TaskService {
  constructor(private db: Database) {}

  async createTask(taskData: Partial<Task>): Promise<Task> {
    const task: Task = {
      id: uuidv4(),
      title: taskData.title || '',
      description: taskData.description || '',
      completed: taskData.completed || false,
      created_at: new Date(),
      updated_at: new Date(),
      is_deleted: false,
      sync_status: 'pending',
      server_id: taskData.server_id || undefined,
      last_synced_at: taskData.last_synced_at || undefined
    };

    const sql = `
      INSERT INTO tasks (
        id, title, description, completed, created_at, updated_at,
        is_deleted, sync_status, server_id, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.db.run(sql, [
      task.id,
      task.title,
      task.description,
      task.completed ? 1 : 0,
      task.created_at.toISOString(),
      task.updated_at.toISOString(),
      task.is_deleted ? 1 : 0,
      task.sync_status,
      task.server_id || null,
      task.last_synced_at?.toISOString() || null
    ]);

    // Add to sync queue
    await this.addToSyncQueue(task.id, 'create', task);

    return task;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    // Check if task exists and is not deleted
    const existing = await this.getTask(id);
    if (!existing) {
      return null;
    }

    const updatedTask = {
      ...existing,
      ...updates,
      updated_at: new Date(),
      sync_status: 'pending' as const
    };

    const sql = `
      UPDATE tasks SET
        title = ?, description = ?, completed = ?, updated_at = ?,
        sync_status = ?, server_id = ?, last_synced_at = ?
      WHERE id = ? AND is_deleted = 0
    `;

    await this.db.run(sql, [
      updatedTask.title,
      updatedTask.description || '',
      updatedTask.completed ? 1 : 0,
      updatedTask.updated_at.toISOString(),
      updatedTask.sync_status,
      updatedTask.server_id || null,
      updatedTask.last_synced_at?.toISOString() || null,
      id
    ]);

    // Adding to sync queue
    await this.addToSyncQueue(id, 'update', updatedTask);

    return updatedTask;
  }

  async deleteTask(id: string): Promise<boolean> {
    // Checking if task exists and is not already deleted
    const existing = await this.db.get(
      'SELECT * FROM tasks WHERE id = ? AND is_deleted = 0',
      [id]
    );

    if (!existing) {
      return false;
    }

    const now = new Date();
    const sql = `
      UPDATE tasks SET
        is_deleted = 1, updated_at = ?, sync_status = ?
      WHERE id = ?
    `;

    await this.db.run(sql, [now.toISOString(), 'pending', id]);

    // Adding to sync queue with the current task data
    const taskData = this.mapRowToTask(existing);
    taskData.is_deleted = true;
    taskData.updated_at = now;
    await this.addToSyncQueue(id, 'delete', taskData);

    return true;
  }

  async getTask(id: string): Promise<Task | null> {
    const row = await this.db.get(
      'SELECT * FROM tasks WHERE id = ? AND is_deleted = 0',
      [id]
    );

    if (!row) {
      return null;
    }

    return this.mapRowToTask(row);
  }

  async getAllTasks(): Promise<Task[]> {
    const rows = await this.db.all(
      'SELECT * FROM tasks WHERE is_deleted = 0 ORDER BY created_at DESC'
    );

    return rows.map(row => this.mapRowToTask(row));
  }

  async getTasksNeedingSync(): Promise<Task[]> {
    const rows = await this.db.all(
      "SELECT * FROM tasks WHERE sync_status IN ('pending', 'error') ORDER BY updated_at ASC"
    );

    return rows.map(row => this.mapRowToTask(row));
  }

  private mapRowToTask(row: any): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description || '',
      completed: Boolean(row.completed),
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: Boolean(row.is_deleted),
      sync_status: row.sync_status,
      server_id: row.server_id || undefined,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined
    };
  }

  private async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
    const queueId = uuidv4();
    const sql = `
      INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count)
      VALUES (?, ?, ?, ?, ?, 0)
    `;

    await this.db.run(sql, [
      queueId,
      taskId,
      operation,
      JSON.stringify(data),
      new Date().toISOString()
    ]);
  }
}