import * as fs from 'fs';
import { join } from 'path';

import { Logger } from 'log4js';

import { FileStatus } from '@/type/fileStatus';

export class FileStatusManager {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  private getFileStatusPath(dirName: string): string {
    return join(dirName, 'fileStatus.json');
  }

  readFileStatus(dirName: string): FileStatus | null {
    const filePath = this.getFileStatusPath(dirName);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const status = JSON.parse(content) as FileStatus;
      this.logger.debug(`读取文件状态: ${JSON.stringify(status, null, 2)}`);
      return status;
    } catch (error) {
      this.logger.error(`读取文件状态失败: ${filePath}`, error);
      return null;
    }
  }

  writeFileStatus(dirName: string, status: Partial<FileStatus>): boolean {
    const filePath = this.getFileStatusPath(dirName);

    try {
      let existingStatus: FileStatus = {};

      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        existingStatus = JSON.parse(content);
      }

      const mergedStatus = { ...existingStatus, ...status };
      const content = JSON.stringify(mergedStatus, null, 2);

      fs.writeFileSync(filePath, content, 'utf8');
      this.logger.debug(`写入文件状态: ${JSON.stringify(mergedStatus, null, 2)}`);

      return true;
    } catch (error) {
      this.logger.error(`写入文件状态失败: ${filePath}`, error);
      return false;
    }
  }

  createInitialFileStatus(dirName: string, recorderTask: any): boolean {
    const filePath = this.getFileStatusPath(dirName);

    if (fs.existsSync(filePath)) {
      this.logger.info(`文件状态已存在: ${filePath}`);
      return true;
    }

    const initialStatus: FileStatus = {
      path: dirName,
      recorderName: recorderTask.recorderName,
      recorderLink: recorderTask.streamerInfo.roomUrl,
      tags: recorderTask.streamerInfo.tags,
      tid: recorderTask.streamerInfo.tid,
      startRecordTime: new Date(),
      uploadLocalFile: recorderTask.streamerInfo.uploadLocalFile,
      deleteLocalFile: recorderTask.streamerInfo.deleteLocalFile,
      isPost: false,
      isFailed: false,
      delayTime: recorderTask.streamerInfo.delayTime ?? 2,
      templateTitle: recorderTask.streamerInfo.templateTitle || '',
      desc: recorderTask.streamerInfo.desc || '',
      source: recorderTask.streamerInfo.source || '',
      dynamic: recorderTask.streamerInfo.dynamic || '',
      copyright: recorderTask.streamerInfo.copyright ?? 2,
      timeV: recorderTask.timeV,
    };

    return this.writeFileStatus(dirName, initialStatus);
  }

  markRecordingEnd(dirName: string): boolean {
    return this.writeFileStatus(dirName, {
      endRecordTime: new Date(),
    });
  }

  markUploadSuccess(dirName: string): boolean {
    return this.writeFileStatus(dirName, {
      isPost: true,
      isFailed: false,
    });
  }

  markUploadFailed(dirName: string, failureInfo: any): boolean {
    return this.writeFileStatus(dirName, {
      isFailed: true,
      videoParts: {
        failUpload: failureInfo,
      },
    });
  }

  addSuccessfulUpload(dirName: string, videoInfo: any): boolean {
    const currentStatus = this.readFileStatus(dirName);
    if (!currentStatus) {
      this.logger.error(`无法读取当前文件状态: ${dirName}`);
      return false;
    }

    if (!currentStatus.videoParts) {
      currentStatus.videoParts = {};
    }

    if (!currentStatus.videoParts.succeedUploaded) {
      currentStatus.videoParts.succeedUploaded = [];
    }

    const existingVideo = currentStatus.videoParts.succeedUploaded.find(
      item => item.localFilePath === videoInfo.localFilePath
    );

    if (existingVideo) {
      this.logger.info(`视频已存在于成功列表: ${videoInfo.localFilePath}`);
      return true;
    }

    currentStatus.videoParts.succeedUploaded.push(videoInfo);
    return this.writeFileStatus(dirName, currentStatus);
  }
}
