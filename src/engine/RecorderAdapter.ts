import { taskScheduler } from '../core/TaskScheduler';

import { Recorder } from './message';

import { getExtendedLogger } from '@/log';
import { RecorderTask } from '@/type/recorderTask';

/**
 * 适配器类：用于逐步从旧的Recorder类迁移到新的TaskScheduler架构
 * 保持向后兼容性的同时引入新的状态管理
 */
export class RecorderAdapter {
  private logger = getExtendedLogger('RecorderAdapter');

  // 存储旧版录制器实例，用于兼容现有代码
  private legacyRecorders = new Map<string, Recorder>();

  /**
   * 启动录制任务
   * 优先使用新的TaskScheduler，如果失败则回退到旧的Recorder
   */
  async startRecording(task: RecorderTask, streamUrl?: string): Promise<Recorder | void> {
    try {
      // 尝试使用新的TaskScheduler
      await taskScheduler.startRecording(task, streamUrl);
      this.logger.info(`使用新架构启动录制: ${task.recorderName}`);
      return; // 新架构成功，直接返回
    } catch (error) {
      this.logger.warn(`新架构启动失败，回退到旧版: ${task.recorderName}`, error);

      // 回退到旧的Recorder
      const legacyRecorder = new Recorder(task);
      this.legacyRecorders.set(task.recorderName, legacyRecorder);

      legacyRecorder.startRecord(streamUrl);
      return legacyRecorder;
    }
  }

  /**
   * 停止录制任务
   */
  stopRecording(recorderName: string): void {
    try {
      // 先尝试停止新架构的任务
      if (taskScheduler.isRecording(recorderName)) {
        taskScheduler.stopRecording(recorderName);
        this.logger.info(`使用新架构停止录制: ${recorderName}`);
        return;
      }
    } catch (error) {
      this.logger.debug(`新架构停止失败: ${recorderName}`, error);
    }

    // 回退到旧版录制器
    const legacyRecorder = this.legacyRecorders.get(recorderName);
    if (legacyRecorder) {
      legacyRecorder.stopRecord();
      this.legacyRecorders.delete(recorderName);
      this.logger.info(`使用旧版架构停止录制: ${recorderName}`);
    } else {
      this.logger.warn(`找不到录制任务: ${recorderName}`);
    }
  }

  /**
   * 获取录制状态
   */
  getRecordingStatus(recorderName: string): any {
    // 优先检查新架构
    const newStatus = taskScheduler.getRecordingStatus(recorderName);
    if (newStatus) {
      return {
        isRecording: taskScheduler.isRecording(recorderName),
        status: newStatus,
        source: 'new',
      };
    }

    // 检查旧版录制器
    const legacyRecorder = this.legacyRecorders.get(recorderName);
    if (legacyRecorder) {
      return {
        isRecording: legacyRecorder.recorderStat(),
        recorder: legacyRecorder,
        source: 'legacy',
      };
    }

    return null;
  }

  /**
   * 检查是否正在录制
   */
  isRecording(recorderName: string): boolean {
    // 检查新架构
    if (taskScheduler.isRecording(recorderName)) {
      return true;
    }

    // 检查旧版录制器
    const legacyRecorder = this.legacyRecorders.get(recorderName);
    return legacyRecorder?.recorderStat() || false;
  }

  /**
   * 获取所有活跃的录制任务
   */
  getActiveRecordings(): string[] {
    const newRecordings = taskScheduler.getActiveRecorders();
    const legacyRecordings = Array.from(this.legacyRecorders.keys());

    return [...new Set([...newRecordings, ...legacyRecordings])];
  }

  /**
   * 获取录制器实例（用于向后兼容）
   */
  getRecorderInstance(recorderName: string): Recorder | null {
    return this.legacyRecorders.get(recorderName) || null;
  }

  /**
   * 清理所有录制任务
   */
  shutdown(): void {
    this.logger.info('正在关闭录制适配器...');

    // 停止新架构任务
    try {
      taskScheduler.shutdown();
    } catch (error) {
      this.logger.error('关闭新架构失败', error);
    }

    // 停止旧版录制器
    this.legacyRecorders.forEach((recorder, name) => {
      try {
        recorder.stopRecord();
        this.logger.info(`停止旧版录制器: ${name}`);
      } catch (error) {
        this.logger.error(`停止旧版录制器失败: ${name}`, error);
      }
    });

    this.legacyRecorders.clear();
    this.logger.info('录制适配器已关闭');
  }

  /**
   * 迁移统计信息
   */
  getMigrationStats(): any {
    return {
      newArchitecture: {
        active: taskScheduler.getActiveRecorders().length,
        tasks: taskScheduler.getAllTasks().length,
      },
      legacyArchitecture: {
        active: this.legacyRecorders.size,
      },
      total: taskScheduler.getActiveRecorders().length + this.legacyRecorders.size,
    };
  }
}

// 单例导出
export const recorderAdapter = new RecorderAdapter();
