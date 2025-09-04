import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { Task, SyncQueueItem, SyncResult, BatchSyncRequest, BatchSyncResponse } from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';

export class SyncService {
  private apiUrl: string;
  private batchSize: number;
  
  constructor(
    private db: Database,
    _taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
    this.batchSize = parseInt(process.env.SYNC_BATCH_SIZE || '50');
  }

  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      synced_items: 0,
      failed_items: 0,
      errors: []
    };

    try {
      // Check connectivity first
      const isOnline = await this.checkConnectivity();
      if (!isOnline) {
        result.success = false;
        result.errors.push({
          task_id: '',
          operation: 'connectivity',
          error: 'Server unreachable',
          timestamp: new Date()
        });
        return result;
      }

      // Get all items from sync queue ordered chronologically per task
      const queueItems = await this.getSyncQueueItems();
      
      if (queueItems.length === 0) {
        return result;
      }

      // Group items by batch while maintaining chronological order per task
      const batches = this.createBatches(queueItems);
      
      // Process each batch
      for (const batch of batches) {
        try {
          const batchResult = await this.processBatch(batch);
          
          // Process the response
          for (const processedItem of batchResult.processed_items) {
            if (processedItem.status === 'success') {
              await this.updateSyncStatus(
                processedItem.client_id,
                'synced',
                processedItem.resolved_data
              );
              result.synced_items++;
            } else {
              await this.handleSyncError(
                batch.find(item => item.task_id === processedItem.client_id)!,
                new Error(processedItem.error || 'Unknown sync error')
              );
              result.failed_items++;
              result.errors.push({
                task_id: processedItem.client_id,
                operation: 'sync',
                error: processedItem.error || 'Unknown sync error',
                timestamp: new Date()
              });
            }
          }
        } catch (error) {
          // Handle entire batch failure
          for (const item of batch) {
            await this.handleSyncError(item, error as Error);
            result.failed_items++;
            result.errors.push({
              task_id: item.task_id,
              operation: item.operation,
              error: (error as Error).message,
              timestamp: new Date()
            });
          }
        }
      }

      result.success = result.failed_items === 0;
      
    } catch (error) {
      result.success = false;
      result.errors.push({
        task_id: '',
        operation: 'sync',
        error: (error as Error).message,
        timestamp: new Date()
      });
    }

    return result;
  }

  async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
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

  private async getSyncQueueItems(): Promise<SyncQueueItem[]> {
    const sql = `
      SELECT * FROM sync_queue 
      WHERE retry_count < 3
      ORDER BY task_id, created_at ASC
    `;
    
    const rows = await this.db.all(sql);
    
    return rows.map(row => ({
      id: row.id,
      task_id: row.task_id,
      operation: row.operation,
      data: JSON.parse(row.data),
      created_at: new Date(row.created_at),
      retry_count: row.retry_count,
      error_message: row.error_message
    }));
  }

  private createBatches(items: SyncQueueItem[]): SyncQueueItem[][] {
    const batches: SyncQueueItem[][] = [];
    let currentBatch: SyncQueueItem[] = [];

    for (const item of items) {
      if (currentBatch.length >= this.batchSize) {
        batches.push(currentBatch);
        currentBatch = [];
      }
      currentBatch.push(item);
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
    // Update sync status to 'in-progress' for all items in batch
    for (const item of items) {
      await this.db.run(
        'UPDATE tasks SET sync_status = ? WHERE id = ?',
        ['in-progress', item.task_id]
      );
    }

    // Create checksum for batch integrity
    const checksum = this.calculateChecksum(items);
    
    const batchRequest: BatchSyncRequest = {
      items,
      client_timestamp: new Date()
    };

    const response = await axios.post(`${this.apiUrl}/batch`, {
      ...batchRequest,
      checksum
    }, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  }

  private calculateChecksum(items: SyncQueueItem[]): string {
    const dataString = items
      .map(item => `${item.id}-${item.operation}-${JSON.stringify(item.data)}`)
      .join('|');
    
    return crypto.createHash('sha256').update(dataString).digest('hex');
  }


  private async updateSyncStatus(taskId: string, status: 'synced' | 'error', serverData?: Partial<Task>): Promise<void> {
    const now = new Date();
    let sql = `
      UPDATE tasks SET
        sync_status = ?, last_synced_at = ?
    `;
    const params = [status, now.toISOString()];

    if (serverData?.server_id) {
      sql += ', server_id = ?';
      params.push(serverData.server_id);
    }

    sql += ' WHERE id = ?';
    params.push(taskId);

    await this.db.run(sql, params);

    // If successful, remove from sync queue
    if (status === 'synced') {
      await this.db.run('DELETE FROM sync_queue WHERE task_id = ?', [taskId]);
    }
  }

  private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
    const retryCount = item.retry_count + 1;
    const maxRetries = 3;

    if (retryCount >= maxRetries) {
      // Move to dead letter queue and mark as failed
      await this.moveToDeadLetterQueue(item, error.message);
      await this.db.run(
        'UPDATE tasks SET sync_status = ? WHERE id = ?',
        ['failed', item.task_id]
      );
      await this.db.run('DELETE FROM sync_queue WHERE id = ?', [item.id]);
    } else {
      // Update retry count and error message
      await this.db.run(
        'UPDATE sync_queue SET retry_count = ?, error_message = ? WHERE id = ?',
        [retryCount, error.message, item.id]
      );
      // Reset task status to error for retry
      await this.db.run(
        'UPDATE tasks SET sync_status = ? WHERE id = ?',
        ['error', item.task_id]
      );
    }

    console.error(`Sync error for task ${item.task_id} (attempt ${retryCount}/${maxRetries}):`, error.message);
  }

  private async moveToDeadLetterQueue(item: SyncQueueItem, errorMessage: string): Promise<void> {
    // Create dead_letter_queue table if it doesn't exist
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS dead_letter_queue (
        id TEXT PRIMARY KEY,
        original_queue_id TEXT,
        task_id TEXT,
        operation TEXT,
        data TEXT,
        error_message TEXT,
        retry_count INTEGER,
        failed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const dlqId = uuidv4();
    await this.db.run(`
      INSERT INTO dead_letter_queue (
        id, original_queue_id, task_id, operation, data, error_message, retry_count, failed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      dlqId,
      item.id,
      item.task_id,
      item.operation,
      JSON.stringify(item.data),
      errorMessage,
      item.retry_count,
      new Date().toISOString()
    ]);
  }

  async checkConnectivity(): Promise<boolean> {
    try {
      await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async getSyncStatus(): Promise<{
    pending_sync_count: number;
    last_sync_timestamp: Date | null;
    is_online: boolean;
    sync_queue_size: number;
  }> {
    const [pendingCount, queueSize, lastSync, isOnline] = await Promise.all([
      this.db.get("SELECT COUNT(*) as count FROM tasks WHERE sync_status IN ('pending', 'error')"),
      this.db.get('SELECT COUNT(*) as count FROM sync_queue'),
      this.db.get('SELECT MAX(last_synced_at) as last_sync FROM tasks WHERE last_synced_at IS NOT NULL'),
      this.checkConnectivity()
    ]);

    return {
      pending_sync_count: pendingCount.count,
      last_sync_timestamp: lastSync?.last_sync ? new Date(lastSync.last_sync) : null,
      is_online: isOnline,
      sync_queue_size: queueSize.count
    };
  }

  async getDeadLetterQueue(): Promise<any[]> {
    try {
      const rows = await this.db.all('SELECT * FROM dead_letter_queue ORDER BY failed_at DESC');
      return rows;
    } catch {
      return [];
    }
  }
}