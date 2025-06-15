import { EventEmitter } from 'events';

export enum TaskState {
  IDLE = 'idle',
  RECORDING = 'recording',
  UPLOADING = 'uploading',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface TaskStatus {
  id: string;
  state: TaskState;
  progress?: number;
  error?: Error;
  metadata?: any;
  updatedAt: Date;
}

export class StateManager extends EventEmitter {
  private static instance: StateManager;
  private tasks: Map<string, TaskStatus> = new Map();

  private constructor() {
    super();
  }

  static getInstance(): StateManager {
    if (!StateManager.instance) {
      StateManager.instance = new StateManager();
    }
    return StateManager.instance;
  }

  setTaskState(taskId: string, state: TaskState, metadata?: any): void {
    const existingTask = this.tasks.get(taskId);

    const taskStatus: TaskStatus = {
      id: taskId,
      state,
      progress: existingTask?.progress || 0,
      metadata: { ...existingTask?.metadata, ...metadata },
      updatedAt: new Date(),
    };

    this.tasks.set(taskId, taskStatus);
    this.emit('stateChanged', taskStatus);
  }

  getTaskState(taskId: string): TaskStatus | undefined {
    return this.tasks.get(taskId);
  }

  isTaskInState(taskId: string, state: TaskState): boolean {
    const task = this.tasks.get(taskId);
    return task?.state === state;
  }

  canStartTask(taskId: string): boolean {
    const currentTask = this.tasks.get(taskId);

    if (!currentTask) return true;

    if (currentTask.state === TaskState.RECORDING || currentTask.state === TaskState.UPLOADING) {
      return false;
    }

    return true;
  }

  updateProgress(taskId: string, progress: number): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.progress = progress;
      task.updatedAt = new Date();
      this.emit('progressUpdated', task);
    }
  }

  setTaskError(taskId: string, error: Error): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.error = error;
      task.state = TaskState.FAILED;
      task.updatedAt = new Date();
      this.emit('taskFailed', task);
    }
  }

  removeTask(taskId: string): void {
    this.tasks.delete(taskId);
    this.emit('taskRemoved', taskId);
  }

  getAllTasks(): TaskStatus[] {
    return Array.from(this.tasks.values());
  }

  getTasksByState(state: TaskState): TaskStatus[] {
    return Array.from(this.tasks.values()).filter(task => task.state === state);
  }
}

export const stateManager = StateManager.getInstance();
