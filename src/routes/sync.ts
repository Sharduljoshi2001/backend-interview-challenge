import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Triggering manual sync
  router.post('/sync', async (req: Request, res: Response) => {
    try {
      // Checking connectivity first
      const isOnline = await syncService.checkConnectivity();
      if (!isOnline) {
        return res.status(503).json({
          error: 'Server unavailable - cannot sync while offline',
          timestamp: new Date(),
          path: req.path
        });
      }

      // Performing sync
      const syncResult = await syncService.sync();
      
      return res.json(syncResult);
    } catch (error) {
      console.error('Sync error:', error);
      return res.status(500).json({
        error: 'Sync operation failed',
        timestamp: new Date(),
        path: req.path
      });
    }
  });

  // Checking sync status
  router.get('/status', async (req: Request, res: Response) => {
    try {
      const status = await syncService.getSyncStatus();
      res.json(status);
    } catch (error) {
      console.error('Status check error:', error);
      res.status(500).json({
        error: 'Failed to get sync status',
        timestamp: new Date(),
        path: req.path
      });
    }
  });

  // Batch sync endpoint (for server-side implementation)
  router.post('/batch', async (req: Request, res: Response) => {
    try {
      const { items, client_timestamp, checksum } = req.body;

      // Validating request
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
          error: 'Invalid batch request - items array is required',
          timestamp: new Date(),
          path: req.path
        });
      }

      if (!client_timestamp) {
        return res.status(400).json({
          error: 'Client timestamp is required',
          timestamp: new Date(),
          path: req.path
        });
      }

      // Verifying checksum for batch integrity (as per challenge constraints)
      if (checksum) {
        const calculatedChecksum = calculateChecksum(items);
        if (calculatedChecksum !== checksum) {
          return res.status(400).json({
            error: 'Batch integrity check failed - checksum mismatch',
            timestamp: new Date(),
            path: req.path
          });
        }
      }

      // Processing the batch items
      const processed_items = [];
      
      for (const item of items) {
        try {
          let result;
          
          switch (item.operation) {
            case 'create':
              result = await handleBatchCreate(taskService, item);
              break;
            case 'update':
              result = await handleBatchUpdate(taskService, item);
              break;
            case 'delete':
              result = await handleBatchDelete(taskService, item);
              break;
            default:
              result = {
                client_id: item.task_id,
                server_id: null,
                status: 'error' as const,
                error: `Unknown operation: ${item.operation}`
              };
          }
          
          processed_items.push(result);
        } catch (error) {
          processed_items.push({
            client_id: item.task_id,
            server_id: null,
            status: 'error' as const,
            error: (error as Error).message
          });
        }
      }

      return res.json({
        processed_items
      });
    } catch (error) {
      console.error('Batch sync error:', error);
      return res.status(500).json({
        error: 'Batch sync failed',
        timestamp: new Date(),
        path: req.path
      });
    }
  });

  // Health check endpoint
  router.get('/health', async (_req: Request, res: Response) => {
    return res.json({ status: 'ok', timestamp: new Date() });
  });

  // Dead letter queue endpoint for debugging
  router.get('/dead-letter-queue', async (req: Request, res: Response) => {
    try {
      const dlqItems = await syncService.getDeadLetterQueue();
      res.json({
        count: dlqItems.length,
        items: dlqItems
      });
    } catch (error) {
      console.error('Dead letter queue error:', error);
      res.status(500).json({
        error: 'Failed to get dead letter queue',
        timestamp: new Date(),
        path: req.path
      });
    }
  });

  return router;
}

// Helper functions for batch processing
async function handleBatchCreate(taskService: TaskService, item: any) {
  try {
    const task = await taskService.createTask(item.data);
    return {
      client_id: item.task_id,
      server_id: task.id,
      status: 'success' as const,
      resolved_data: task
    };
  } catch (error) {
    return {
      client_id: item.task_id,
      server_id: null,
      status: 'error' as const,
      error: (error as Error).message
    };
  }
}

async function handleBatchUpdate(taskService: TaskService, item: any) {
  try {
    const existingTask = await taskService.getTask(item.task_id);
    
    if (!existingTask) {
      // Task doesn't exist, treat as create
      const task = await taskService.createTask(item.data);
      return {
        client_id: item.task_id,
        server_id: task.id,
        status: 'success' as const,
        resolved_data: task
      };
    }

    // Check for conflicts and resolve using last-write-wins
    const serverTime = existingTask.updated_at.getTime();
    const clientTime = new Date(item.data.updated_at).getTime();
    
    let finalData = item.data;
    if (serverTime > clientTime) {
      // Server wins - return server data
      finalData = existingTask;
    } else {
      // Client wins - apply update
      const updatedTask = await taskService.updateTask(item.task_id, item.data);
      finalData = updatedTask || existingTask;
    }

    return {
      client_id: item.task_id,
      server_id: finalData.server_id || finalData.id,
      status: 'success' as const,
      resolved_data: finalData
    };
  } catch (error) {
    return {
      client_id: item.task_id,
      server_id: null,
      status: 'error' as const,
      error: (error as Error).message
    };
  }
}

async function handleBatchDelete(taskService: TaskService, item: any) {
  try {
    await taskService.deleteTask(item.task_id);
    
    return {
      client_id: item.task_id,
      server_id: item.task_id,
      status: 'success' as const,
      resolved_data: { ...item.data, is_deleted: true }
    };
  } catch (error) {
    return {
      client_id: item.task_id,
      server_id: null,
      status: 'error' as const,
      error: (error as Error).message
    };
  }
}

function calculateChecksum(items: any[]): string {
  const crypto = require('crypto');
  const dataString = items
    .map(item => `${item.id}-${item.operation}-${JSON.stringify(item.data)}`)
    .join('|');
  
  return crypto.createHash('sha256').update(dataString).digest('hex');
}