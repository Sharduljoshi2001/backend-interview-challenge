import { Router, Request, Response } from 'express';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';

export function createTaskRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);

  // Get all tasks
  router.get('/', async (req: Request, res: Response) => {
    try {
      const tasks = await taskService.getAllTasks();
      res.json(tasks);
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to fetch tasks',
        timestamp: new Date(),
        path: req.path
      });
    }
  });

  // Get single task
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        return res.status(404).json({ 
          error: 'Task not found',
          timestamp: new Date(),
          path: req.path
        });
      }
      return res.json(task);
    } catch (error) {
      return res.status(500).json({ 
        error: 'Failed to fetch task',
        timestamp: new Date(),
        path: req.path
      });
    }
  });

  // Create task
  router.post('/', async (req: Request, res: Response) => {
    try {
      // Validate request body
      const { title, description } = req.body;
      
      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        return res.status(400).json({ 
          error: 'Title is required and must be a non-empty string',
          timestamp: new Date(),
          path: req.path
        });
      }

      const taskData = {
        title: title.trim(),
        description: description?.trim() || ''
      };

      const task = await taskService.createTask(taskData);
      return res.status(201).json(task);
    } catch (error) {
      console.error('Error creating task:', error);
      return res.status(500).json({ 
        error: 'Failed to create task',
        timestamp: new Date(),
        path: req.path
      });
    }
  });

  // Update task
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updates = req.body;

      // Validate request body
      const allowedUpdates = ['title', 'description', 'completed'];
      const providedUpdates = Object.keys(updates);
      const isValidOperation = providedUpdates.every(update => allowedUpdates.includes(update));

      if (!isValidOperation) {
        return res.status(400).json({
          error: 'Invalid updates. Allowed fields: title, description, completed',
          timestamp: new Date(),
          path: req.path
        });
      }

      // Validate title if provided
      if (updates.title !== undefined) {
        if (typeof updates.title !== 'string' || updates.title.trim().length === 0) {
          return res.status(400).json({
            error: 'Title must be a non-empty string',
            timestamp: new Date(),
            path: req.path
          });
        }
        updates.title = updates.title.trim();
      }

      // Validate description if provided
      if (updates.description !== undefined && typeof updates.description !== 'string') {
        return res.status(400).json({
          error: 'Description must be a string',
          timestamp: new Date(),
          path: req.path
        });
      }

      // Validate completed if provided
      if (updates.completed !== undefined && typeof updates.completed !== 'boolean') {
        return res.status(400).json({
          error: 'Completed must be a boolean',
          timestamp: new Date(),
          path: req.path
        });
      }

      const updatedTask = await taskService.updateTask(id, updates);
      
      if (!updatedTask) {
        return res.status(404).json({
          error: 'Task not found',
          timestamp: new Date(),
          path: req.path
        });
      }

      return res.json(updatedTask);
    } catch (error) {
      console.error('Error updating task:', error);
      return res.status(500).json({ 
        error: 'Failed to update task',
        timestamp: new Date(),
        path: req.path
      });
    }
  });

  // Delete task
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const success = await taskService.deleteTask(id);
      
      if (!success) {
        return res.status(404).json({
          error: 'Task not found',
          timestamp: new Date(),
          path: req.path
        });
      }

      return res.status(204).send();
    } catch (error) {
      console.error('Error deleting task:', error);
      return res.status(500).json({ 
        error: 'Failed to delete task',
        timestamp: new Date(),
        path: req.path
      });
    }
  });

  return router;
}