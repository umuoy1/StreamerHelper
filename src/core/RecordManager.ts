import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { join } from 'path';

import * as dayjs from 'dayjs';
import { Logger } from 'log4js';

import { FileStatusManager } from './FileStatusManager';
import { stateManager, TaskState } from './StateManager';

import { getExtendedLogger } from '@/log';
import { RecorderTask } from '@/type/recorderTask';
import * as FileHound from 'filehound';

const RECORDING_CONFIG = {
  PART_DURATION: '3000',
  VIDEO_EXT: 'mp4',
  SAVE_ROOT_PATH: join(process.cwd(), '/download'),
};

export class RecordManager {
  private savePath: string = '';
  private ffmpegProcess: ChildProcess | null = null;
  private isManualStop = false;
  private logger: Logger;
  private fileStatusManager: FileStatusManager;
  private readonly task: RecorderTask;

  constructor(task: RecorderTask) {
    this.task = { ...task };
    this.task.timeV = this.generateTimeVersion();
    this.logger = getExtendedLogger(`Record-${this.task.recorderName}`);
    this.fileStatusManager = new FileStatusManager(this.logger);
  }

  private generateTimeVersion(): string {
    return `${dayjs().format('YYYY-MM-DD')} ${this.getTimePostfix()}`;
  }

  private getTimePostfix(): string {
    const now = dayjs();
    const hour = now.hour();
    if (hour >= 0 && hour < 6) return '凌晨';
    if (hour >= 6 && hour < 12) return '早上';
    if (hour >= 12 && hour < 18) return '下午';
    if (hour >= 18 && hour < 24) return '晚上';
    return '';
  }

  async startRecording(streamUrl?: string): Promise<void> {
    const taskId = this.getTaskId();

    if (!stateManager.canStartTask(taskId)) {
      throw new Error(`任务 ${this.task.recorderName} 已在进行中，无法启动新的录制`);
    }

    try {
      this.task.streamUrl = streamUrl || this.task.streamUrl;
      if (!this.task.streamUrl) {
        throw new Error('录制流地址不能为空');
      }

      this.logger.info(`开始录制: ${this.task.recorderName}, 流地址: ${this.task.streamUrl}`);

      stateManager.setTaskState(taskId, TaskState.RECORDING, {
        recorderName: this.task.recorderName,
        streamUrl: this.task.streamUrl,
      });

      this.savePath = this.prepareSavePath();
      this.fileStatusManager.createInitialFileStatus(this.savePath, this.task);

      await this.launchFFmpeg();
    } catch (error) {
      stateManager.setTaskError(taskId, error as Error);
      throw error;
    }
  }

  private prepareSavePath(): string {
    const nameBasedPath = join(RECORDING_CONFIG.SAVE_ROOT_PATH, this.task.recorderName);
    this.ensureDirectoryExists(nameBasedPath);

    const timeBasedPath = join(nameBasedPath, this.task.timeV);

    if (!fs.existsSync(timeBasedPath)) {
      fs.mkdirSync(timeBasedPath);
      return timeBasedPath;
    }

    // 检查是否已经上传或正在上传
    const fileStatus = this.fileStatusManager.readFileStatus(timeBasedPath);
    if (fileStatus?.isPost || stateManager.isTaskInState(timeBasedPath, TaskState.UPLOADING)) {
      const currentTime = dayjs().format('HH-mm');
      const newPath = `${timeBasedPath} ${currentTime}`;
      this.task.timeV = `${this.task.timeV} ${currentTime}`;
      fs.mkdirSync(newPath);
      return newPath;
    }

    return timeBasedPath;
  }

  private ensureDirectoryExists(path: string): void {
    if (!fs.existsSync(path)) {
      fs.mkdirSync(path, { recursive: true });
    }
  }

  private async launchFFmpeg(): Promise<void> {
    const startNumber = this.getStartingPartNumber();
    const outputPath = join(
      this.savePath,
      `${this.task.recorderName}-${this.task.timeV}-part-%03d.${RECORDING_CONFIG.VIDEO_EXT}`
    );

    const ffmpegArgs = [
      '-i',
      this.task.streamUrl,
      '-c',
      'copy',
      '-map',
      '0',
      '-f',
      'segment',
      '-segment_time',
      RECORDING_CONFIG.PART_DURATION,
      '-segment_format',
      RECORDING_CONFIG.VIDEO_EXT,
      '-segment_start_number',
      startNumber.toString(),
      '-reset_timestamps',
      '1',
      outputPath,
    ];

    this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    this.setupFFmpegHandlers();
  }

  private getStartingPartNumber(): number {
    try {
      const existingFiles = FileHound.create()
        .ext(RECORDING_CONFIG.VIDEO_EXT)
        .path(this.savePath)
        .findSync();

      return Math.max(0, existingFiles.length - 1);
    } catch {
      return 0;
    }
  }

  private setupFFmpegHandlers(): void {
    if (!this.ffmpegProcess) return;

    this.ffmpegProcess.stdout?.on('data', data => {
      this.logger.debug(`FFmpeg输出: ${data}`);
    });

    this.ffmpegProcess.stderr?.on('data', data => {
      this.logger.debug(`FFmpeg错误输出: ${data}`);
    });

    this.ffmpegProcess.on('close', code => {
      this.handleFFmpegExit(code);
    });

    this.ffmpegProcess.on('error', error => {
      this.logger.error('FFmpeg进程错误:', error);
      this.handleRecordingError(error);
    });
  }

  private handleFFmpegExit(code: number | null): void {
    const taskId = this.getTaskId();

    this.logger.info(`FFmpeg进程退出，代码: ${code}`);
    this.fileStatusManager.markRecordingEnd(this.savePath);

    if (this.isManualStop) {
      stateManager.setTaskState(taskId, TaskState.COMPLETED);
    } else if (code !== 0) {
      const error = new Error(`FFmpeg异常退出，代码: ${code}`);
      stateManager.setTaskError(taskId, error);
    } else {
      stateManager.setTaskState(taskId, TaskState.COMPLETED);
    }

    this.ffmpegProcess = null;
  }

  private handleRecordingError(error: Error): void {
    const taskId = this.getTaskId();
    stateManager.setTaskError(taskId, error);
    this.cleanup();
  }

  stopRecording(): void {
    if (!this.isRecording()) {
      this.logger.warn('录制未在进行中');
      return;
    }

    this.isManualStop = true;
    this.logger.info('停止录制...');

    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGINT');
    }
  }

  isRecording(): boolean {
    const taskId = this.getTaskId();
    return stateManager.isTaskInState(taskId, TaskState.RECORDING);
  }

  getRecordingStatus(): any {
    const taskId = this.getTaskId();
    return stateManager.getTaskState(taskId);
  }

  private getTaskId(): string {
    return this.savePath || `${this.task.recorderName}-${this.task.timeV}`;
  }

  private cleanup(): void {
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill();
      this.ffmpegProcess = null;
    }
  }

  getTask(): RecorderTask {
    return { ...this.task };
  }

  getSavePath(): string {
    return this.savePath;
  }
}
