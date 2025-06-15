import { Logger } from 'log4js';

import { FileStatusManager } from './FileStatusManager';
import { RecordManager } from './RecordManager';
import { stateManager, TaskState } from './StateManager';
import { UploadManager } from './UploadManager';

import { getExtendedLogger } from '@/log';
import { RecorderTask } from '@/type/recorderTask';

export class TaskScheduler {
  private static instance: TaskScheduler;
  private logger: Logger;
  private activeRecorders: Map<string, RecordManager> = new Map();
  private activeUploaders: Map<string, UploadManager> = new Map();
  private fileStatusManager: FileStatusManager;

  private constructor() {
    this.logger = getExtendedLogger('TaskScheduler');
    this.fileStatusManager = new FileStatusManager(this.logger);
    this.setupStateListeners();
  }

  static getInstance(): TaskScheduler {
    if (!TaskScheduler.instance) {
      TaskScheduler.instance = new TaskScheduler();
    }
    return TaskScheduler.instance;
  }

  private setupStateListeners(): void {
    stateManager.on('stateChanged', taskStatus => {
      this.logger.debug(`任务状态变更: ${taskStatus.id} -> ${taskStatus.state}`);
    });

    stateManager.on('taskFailed', taskStatus => {
      this.logger.error(`任务失败: ${taskStatus.id}`, taskStatus.error);
      this.handleTaskFailure(taskStatus);
    });

    stateManager.on('progressUpdated', taskStatus => {
      this.logger.debug(`任务进度更新: ${taskStatus.id} -> ${taskStatus.progress}%`);
    });
  }

  async startRecording(task: RecorderTask, streamUrl?: string): Promise<void> {
    const recorderId = this.getRecorderId(task);

    if (this.activeRecorders.has(recorderId)) {
      throw new Error(`录制任务已存在: ${task.recorderName}`);
    }

    try {
      const recorder = new RecordManager(task);
      this.activeRecorders.set(recorderId, recorder);

      await recorder.startRecording(streamUrl);
      this.logger.info(`录制任务启动成功: ${task.recorderName}`);

      this.scheduleUploadAfterRecording(recorder);
    } catch (error) {
      this.activeRecorders.delete(recorderId);
      throw error;
    }
  }

  stopRecording(recorderName: string): void {
    const recorderId = this.getRecorderIdByName(recorderName);
    const recorder = this.activeRecorders.get(recorderId);

    if (!recorder) {
      throw new Error(`录制任务不存在: ${recorderName}`);
    }

    recorder.stopRecording();
    this.activeRecorders.delete(recorderId);
    this.logger.info(`录制任务停止: ${recorderName}`);
  }

  async startUpload(task: RecorderTask): Promise<void> {
    const uploaderId = this.getUploaderId(task);

    if (this.activeUploaders.has(uploaderId)) {
      throw new Error(`上传任务已存在: ${task.dirName}`);
    }

    if (task.dirName && !stateManager.canStartTask(task.dirName)) {
      throw new Error(`目录正在使用中，无法启动上传: ${task.dirName}`);
    }

    try {
      const uploader = new UploadManager(task);
      this.activeUploaders.set(uploaderId, uploader);

      await uploader.startUpload();
      this.activeUploaders.delete(uploaderId);
      this.logger.info(`上传任务完成: ${task.dirName}`);
    } catch (error) {
      this.activeUploaders.delete(uploaderId);
      throw error;
    }
  }

  private scheduleUploadAfterRecording(recorder: RecordManager): void {
    const checkInterval = setInterval(() => {
      const status = recorder.getRecordingStatus();

      if (status?.state === TaskState.COMPLETED) {
        clearInterval(checkInterval);
        this.handleRecordingCompleted(recorder);
      } else if (status?.state === TaskState.FAILED) {
        clearInterval(checkInterval);
        this.logger.error(`录制失败，跳过上传: ${recorder.getTask().recorderName}`);
      }
    }, 5000);

    setTimeout(
      () => {
        clearInterval(checkInterval);
      },
      30 * 60 * 1000
    );
  }

  private async handleRecordingCompleted(recorder: RecordManager): Promise<void> {
    const task = recorder.getTask();
    const savePath = recorder.getSavePath();

    const fileStatus = this.fileStatusManager.readFileStatus(savePath);
    if (!fileStatus?.uploadLocalFile) {
      this.logger.info(`用户配置不上传: ${task.recorderName}`);
      return;
    }

    const delayTime = (fileStatus.delayTime || 2) * 60 * 1000;
    this.logger.info(`${delayTime / 60000}分钟后开始上传: ${task.recorderName}`);

    setTimeout(async () => {
      try {
        const uploadTask: RecorderTask = {
          ...task,
          dirName: savePath,
        };

        await this.startUpload(uploadTask);
      } catch (error) {
        this.logger.error(`自动上传失败: ${task.recorderName}`, error);
      }
    }, delayTime);
  }

  private handleTaskFailure(taskStatus: any): void {
    // 清理失败的任务
    const recorderId = Array.from(this.activeRecorders.keys()).find(
      id => this.activeRecorders.get(id)?.getSavePath() === taskStatus.id
    );

    if (recorderId) {
      this.activeRecorders.delete(recorderId);
    }

    const uploaderId = Array.from(this.activeUploaders.keys()).find(id =>
      id.includes(taskStatus.id)
    );

    if (uploaderId) {
      this.activeUploaders.delete(uploaderId);
    }
  }

  getRecordingStatus(recorderName: string): any {
    const recorderId = this.getRecorderIdByName(recorderName);
    const recorder = this.activeRecorders.get(recorderId);
    return recorder?.getRecordingStatus();
  }

  getUploadStatus(dirName: string): any {
    return stateManager.getTaskState(dirName);
  }

  getAllTasks(): any[] {
    return stateManager.getAllTasks();
  }

  getActiveRecorders(): string[] {
    return Array.from(this.activeRecorders.keys());
  }

  getActiveUploaders(): string[] {
    return Array.from(this.activeUploaders.keys());
  }

  isRecording(recorderName: string): boolean {
    const recorderId = this.getRecorderIdByName(recorderName);
    const recorder = this.activeRecorders.get(recorderId);
    return recorder?.isRecording() || false;
  }

  isUploading(dirName: string): boolean {
    return stateManager.isTaskInState(dirName, TaskState.UPLOADING);
  }

  private getRecorderId(task: RecorderTask): string {
    return `record_${task.recorderName}_${task.timeV}`;
  }

  private getRecorderIdByName(recorderName: string): string {
    return (
      Array.from(this.activeRecorders.keys()).find(id => id.includes(recorderName)) ||
      `record_${recorderName}`
    );
  }

  private getUploaderId(task: RecorderTask): string {
    return `upload_${task.dirName}`;
  }

  shutdown(): void {
    this.logger.info('正在关闭任务调度器...');

    // 停止所有录制任务
    this.activeRecorders.forEach((recorder, id) => {
      try {
        recorder.stopRecording();
      } catch (error) {
        this.logger.error(`停止录制任务失败: ${id}`, error);
      }
    });

    this.activeRecorders.clear();
    this.activeUploaders.clear();

    this.logger.info('任务调度器已关闭');
  }
}

export const taskScheduler = TaskScheduler.getInstance();
