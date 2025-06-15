import { taskScheduler } from '../core/TaskScheduler';

import { uploader } from './index';

import { getExtendedLogger } from '@/log';
import { RecorderTask } from '@/type/recorderTask';

/**
 * 适配器类：用于逐步从旧的uploader类迁移到新的TaskScheduler架构
 * 保持向后兼容性的同时引入新的状态管理
 */
export class UploadAdapter {
  private logger = getExtendedLogger('UploadAdapter');

  // 存储旧版上传器实例，用于兼容现有代码
  private legacyUploaders = new Map<string, uploader>();

  /**
   * 启动上传任务
   * 优先使用新的TaskScheduler，如果失败则回退到旧的uploader
   */
  async startUpload(task: RecorderTask): Promise<uploader | void> {
    try {
      // 尝试使用新的TaskScheduler
      await taskScheduler.startUpload(task);
      this.logger.info(`使用新架构启动上传: ${task.dirName}`);
      return; // 新架构成功，直接返回
    } catch (error) {
      this.logger.warn(`新架构上传失败，回退到旧版: ${task.dirName}`, error);

      // 回退到旧的uploader
      const legacyUploader = new uploader(task);
      const uploadId = task.dirName || `upload_${task.recorderName}`;
      this.legacyUploaders.set(uploadId, legacyUploader);

      try {
        await legacyUploader.upload();
        this.legacyUploaders.delete(uploadId);
        this.logger.info(`旧版上传完成: ${task.dirName}`);
      } catch (uploadError) {
        this.legacyUploaders.delete(uploadId);
        throw uploadError;
      }

      return legacyUploader;
    }
  }

  /**
   * 获取上传状态
   */
  getUploadStatus(dirName: string): any {
    // 优先检查新架构
    const newStatus = taskScheduler.getUploadStatus(dirName);
    if (newStatus) {
      return {
        isUploading: taskScheduler.isUploading(dirName),
        status: newStatus,
        source: 'new',
      };
    }

    // 检查旧版上传器
    const legacyUploader = this.legacyUploaders.get(dirName);
    if (legacyUploader) {
      return {
        isUploading: true,
        uploader: legacyUploader,
        source: 'legacy',
      };
    }

    return null;
  }

  /**
   * 检查是否正在上传
   */
  isUploading(dirName: string): boolean {
    // 检查新架构
    if (taskScheduler.isUploading(dirName)) {
      return true;
    }

    // 检查旧版上传器
    return this.legacyUploaders.has(dirName);
  }

  /**
   * 获取所有活跃的上传任务
   */
  getActiveUploads(): string[] {
    const newUploads = taskScheduler.getActiveUploaders();
    const legacyUploads = Array.from(this.legacyUploaders.keys());

    return [...new Set([...newUploads, ...legacyUploads])];
  }

  /**
   * 获取上传器实例（用于向后兼容）
   */
  getUploaderInstance(dirName: string): uploader | null {
    return this.legacyUploaders.get(dirName) || null;
  }

  /**
   * 取消上传任务
   */
  cancelUpload(dirName: string): void {
    // 新架构暂不支持取消，只能清理旧版
    const legacyUploader = this.legacyUploaders.get(dirName);
    if (legacyUploader) {
      this.legacyUploaders.delete(dirName);
      this.logger.info(`取消旧版上传任务: ${dirName}`);
    } else {
      this.logger.warn(`找不到要取消的上传任务: ${dirName}`);
    }
  }

  /**
   * 清理所有上传任务
   */
  shutdown(): void {
    this.logger.info('正在关闭上传适配器...');

    // 清理旧版上传器
    this.legacyUploaders.forEach((_, dirName) => {
      this.logger.info(`清理旧版上传器: ${dirName}`);
    });

    this.legacyUploaders.clear();
    this.logger.info('上传适配器已关闭');
  }

  /**
   * 迁移统计信息
   */
  getMigrationStats(): any {
    return {
      newArchitecture: {
        active: taskScheduler.getActiveUploaders().length,
      },
      legacyArchitecture: {
        active: this.legacyUploaders.size,
      },
      total: taskScheduler.getActiveUploaders().length + this.legacyUploaders.size,
    };
  }

  /**
   * 批量处理待上传的文件
   */
  async processPendingUploads(): Promise<void> {
    try {
      // 这里可以添加批量处理逻辑
      // 例如扫描待上传目录，创建上传任务等
      this.logger.info('开始处理待上传文件...');

      // 可以调用原有的 recycleFile 逻辑
      // 或者使用新的 TaskScheduler 来处理
    } catch (error) {
      this.logger.error('处理待上传文件失败', error);
    }
  }
}

// 单例导出
export const uploadAdapter = new UploadAdapter();
