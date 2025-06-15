import * as crypto from 'crypto';
import * as fs from 'fs';
import * as querystring from 'querystring';

import * as formData from 'form-data';
import { Logger } from 'log4js';

import { FileStatusManager } from './FileStatusManager';
import { stateManager, TaskState } from './StateManager';

import { $axios } from '@/http';
import { getExtendedLogger } from '@/log';
import { RecorderTask } from '@/type/recorderTask';
import { localVideoPart, remoteVideoPart, uploadVideoPartInfo } from '@/type/video';
import * as FileHound from 'filehound';

const UPLOAD_CONFIG = {
  CHUNK_SIZE: 5 * 1024 * 1024, // 5MB
  APP_SECRET: 'af125a0d5279fd576c1b4418a3e8276d',
  DEFAULT_VIDEO_LIMIT_SIZE: 100,
  HEADERS: {
    CONNECTION: 'keep-alive',
    CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=UTF-8',
    USER_AGENT: '',
    ACCEPT_ENCODING: 'gzip,deflate',
  },
};

export class UploadManager {
  private logger: Logger;
  private fileStatusManager: FileStatusManager;
  private uploadConfig: any;

  constructor(task: RecorderTask) {
    this.logger = getExtendedLogger(`Upload-${task.recorderName}`);
    this.fileStatusManager = new FileStatusManager(this.logger);
    this.uploadConfig = this.buildUploadConfig(task);
  }

  private buildUploadConfig(task: RecorderTask): any {
    return {
      dirName: task.dirName || '',
      access_token: global.app.user?.access_token || 'xxx',
      mid: global.config.personInfo.mid || 0,
      videoPartLimitSize:
        global.config.StreamerHelper.videoPartLimitSize ?? UPLOAD_CONFIG.DEFAULT_VIDEO_LIMIT_SIZE,
      copyright: task.streamerInfo.copyright || 2,
      desc:
        task.streamerInfo.desc ||
        'Powered By StreamerHelper. https://github.com/ZhangMingZhao1/StreamerHelper',
      source:
        task.streamerInfo.source || `${task.recorderName} 直播间: ${task.streamerInfo.roomUrl}`,
      tags: task.streamerInfo.tags,
      tid: task.streamerInfo.tid,
      title: this.buildTitle(task),
      dynamic:
        task.streamerInfo.dynamic || `${task.recorderName} 直播间: ${task.streamerInfo.roomUrl}`,
      uploadLocalFile: task.streamerInfo.uploadLocalFile !== false,
      recorderName: task.recorderName || '',
    };
  }

  private buildTitle(task: RecorderTask): string {
    if (task.streamerInfo.templateTitle) {
      return this.renderTemplate(task.streamerInfo.templateTitle, {
        time: task.timeV,
        name: task.recorderName,
      });
    }
    return `${task.recorderName} ${task.timeV} 录播`;
  }

  private renderTemplate(template: string, context: Record<string, string>): string {
    return template.replace(/\{\{(.*?)\}\}/g, (_, key) => context[key] || '');
  }

  async startUpload(): Promise<void> {
    const taskId = this.uploadConfig.dirName;

    if (!this.uploadConfig.uploadLocalFile) {
      this.logger.info(`用户配置不上传本地文件: ${this.uploadConfig.recorderName}`);
      return;
    }

    if (!taskId) {
      throw new Error('上传目录路径未设置');
    }

    if (!stateManager.canStartTask(taskId)) {
      throw new Error(`目录 ${taskId} 正在上传中，避免重复上传`);
    }

    try {
      this.logger.info(`开始上传任务: ${taskId}`);
      stateManager.setTaskState(taskId, TaskState.UPLOADING, {
        recorderName: this.uploadConfig.recorderName,
        dirName: taskId,
      });

      const uploadContext = await this.prepareUploadContext();
      const remoteVideos = await this.processVideoUploads(uploadContext);
      await this.publishVideo(remoteVideos);

      this.fileStatusManager.markUploadSuccess(taskId);
      stateManager.setTaskState(taskId, TaskState.COMPLETED);
      this.logger.info('上传任务完成');
    } catch (error) {
      stateManager.setTaskError(taskId, error as Error);
      throw error;
    }
  }

  private async prepareUploadContext(): Promise<any> {
    const fileStatus = this.fileStatusManager.readFileStatus(this.uploadConfig.dirName);
    const localVideos = this.discoverLocalVideos();

    if (localVideos.length === 0 && !fileStatus?.videoParts?.succeedUploaded) {
      throw new Error(`上传目录为空或视频文件不满足大小限制: ${this.uploadConfig.dirName}`);
    }

    return {
      fileStatus,
      localVideos,
      resumeData: this.extractResumeData(fileStatus),
    };
  }

  private extractResumeData(fileStatus: any): any {
    if (!fileStatus?.isFailed || !fileStatus.videoParts?.failUpload) {
      return null;
    }

    const failUpload = fileStatus.videoParts.failUpload;
    return {
      uploadUrl: failUpload.uploadUrl,
      completeUploadUrl: failUpload.completeUploadUrl,
      serverFileName: failUpload.serverFileName,
      succeedUploadChunk: failUpload.succeedUploadChunk || 0,
      succeedTotalLength: failUpload.succeedTotalLength || 0,
      uploadStartTime: failUpload.uploadStartTime || 0,
      deadline: failUpload.deadline || 0,
    };
  }

  private discoverLocalVideos(): localVideoPart[] {
    const videoFiles = FileHound.create().ext('mp4').path(this.uploadConfig.dirName).findSync();

    return videoFiles
      .map(filePath => {
        const stats = fs.statSync(filePath);
        const sizeMB = stats.size / (1024 * 1024);

        if (sizeMB < this.uploadConfig.videoPartLimitSize) {
          this.logger.debug(`跳过小文件: ${filePath} (${sizeMB.toFixed(2)}MB)`);
          return null;
        }

        return {
          localFilePath: filePath,
          fileSize: stats.size,
          title: this.extractFileTitle(filePath),
          desc: this.uploadConfig.desc,
        };
      })
      .filter(Boolean) as localVideoPart[];
  }

  private extractFileTitle(filePath: string): string {
    const fileName = filePath.split('/').pop() || '';
    return fileName.replace(/\.[^/.]+$/, '');
  }

  private async processVideoUploads(context: any): Promise<remoteVideoPart[]> {
    const remoteVideos: remoteVideoPart[] = [];
    const { localVideos, fileStatus, resumeData } = context;

    for (let i = 0; i < localVideos.length; i++) {
      const video = localVideos[i];

      try {
        const uploadData =
          video.isFailed && resumeData ? resumeData : await this.getPreUploadData();

        const remoteVideo = await this.uploadSingleVideo(video, uploadData);
        remoteVideos.push(remoteVideo);

        this.fileStatusManager.addSuccessfulUpload(this.uploadConfig.dirName, {
          ...remoteVideo,
          localFilePath: video.localFilePath,
        });

        const progress = ((i + 1) / localVideos.length) * 100;
        stateManager.updateProgress(this.uploadConfig.dirName, progress);
      } catch (error) {
        this.logger.error(`视频上传失败: ${video.localFilePath}`, error);
        throw error;
      }
    }

    if (fileStatus?.videoParts?.succeedUploaded) {
      remoteVideos.push(...fileStatus.videoParts.succeedUploaded);
    }

    return this.assignVideoTitles(remoteVideos);
  }

  private assignVideoTitles(videos: remoteVideoPart[]): remoteVideoPart[] {
    return videos.map((video, index) => ({
      ...video,
      title: `P${index + 1}`,
    }));
  }

  private async getPreUploadData(): Promise<uploadVideoPartInfo> {
    const profile = 'ugcfx/bup';
    const uploadUrl = 'https://member.bilibili.com/preupload';
    const timestamp = Math.floor(Date.now() / 1000);

    const params: Record<string, any> = {
      access_key: this.uploadConfig.access_token,
      mid: this.uploadConfig.mid,
      profile,
      ts: timestamp,
    };

    const paramString = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('&');

    params.sign = crypto
      .createHash('md5')
      .update(paramString + UPLOAD_CONFIG.APP_SECRET)
      .digest('hex');

    try {
      const response: any = await $axios.$request({
        method: 'GET',
        url: uploadUrl,
        params,
      });

      if (!response.OK || response.OK !== 1) {
        throw new Error(`预上传请求失败: ${JSON.stringify(response)}`);
      }

      return {
        uploadUrl: response.endpoint,
        completeUploadUrl: response.complete,
        serverFileName: response.upos_uri.split('/').pop(),
        deadline: response.timeout,
      };
    } catch (error) {
      throw new Error(`获取预上传数据失败: ${error}`);
    }
  }

  private async uploadSingleVideo(
    video: localVideoPart,
    uploadData: uploadVideoPartInfo
  ): Promise<remoteVideoPart> {
    this.logger.info(`开始上传视频: ${video.localFilePath}`);

    const fileHash = crypto.createHash('md5');
    const chunkCount = Math.ceil(video.fileSize / UPLOAD_CONFIG.CHUNK_SIZE);
    const fileStream = fs.createReadStream(video.localFilePath);

    let uploadedChunks = 0;
    let currentChunk = 0;
    let buffer = Buffer.alloc(0);

    return new Promise((resolve, reject) => {
      fileStream.on('data', async (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        fileHash.update(chunk);

        if (buffer.length >= UPLOAD_CONFIG.CHUNK_SIZE || fileStream.readableEnded) {
          currentChunk++;
          fileStream.pause();

          try {
            await this.uploadChunk(
              uploadData.uploadUrl,
              uploadData.serverFileName,
              buffer,
              currentChunk,
              chunkCount
            );
            uploadedChunks++;

            const progress = (uploadedChunks / chunkCount) * 100;
            this.logger.debug(`上传进度: ${progress.toFixed(1)}% (${currentChunk}/${chunkCount})`);

            buffer = Buffer.alloc(0);
            fileStream.resume();
          } catch (error) {
            fileStream.destroy();
            reject(error);
          }
        }
      });

      fileStream.on('end', async () => {
        try {
          await this.completeUpload(
            uploadData.completeUploadUrl,
            video.fileSize,
            chunkCount,
            fileHash.digest('hex'),
            video.localFilePath
          );

          resolve({
            desc: video.desc,
            title: video.title,
            filename: uploadData.serverFileName,
          });
        } catch (error) {
          reject(error);
        }
      });

      fileStream.on('error', reject);
    });
  }

  private async uploadChunk(
    uploadUrl: string,
    serverFileName: string,
    chunkData: Buffer,
    chunkId: number,
    totalChunks: number
  ): Promise<void> {
    const chunkHash = crypto.createHash('md5').update(chunkData).digest('hex');
    const form = new formData();

    form.append('version', '2.0.0.1054');
    form.append('filesize', chunkData.length.toString());
    form.append('chunk', chunkId.toString());
    form.append('chunks', totalChunks.toString());
    form.append('md5', chunkHash);
    form.append('file', chunkData, 'application/octet-stream');

    const headers = {
      Cookie: `PHPSESSID=${serverFileName};`,
      ...form.getHeaders(),
    };

    try {
      const response = await $axios.$request({
        method: 'POST',
        url: uploadUrl,
        headers,
        data: form.getBuffer(),
      });

      if (response.info !== 'Successful.') {
        throw new Error(`上传块失败: ${response.info}`);
      }
    } catch (error) {
      throw new Error(`上传块 ${chunkId}/${totalChunks} 失败: ${error}`);
    }
  }

  private async completeUpload(
    completeUrl: string,
    fileSize: number,
    chunks: number,
    md5: string,
    fileName: string
  ): Promise<any> {
    const postData = {
      chunks: chunks.toString(),
      filesize: fileSize.toString(),
      md5,
      name: fileName,
      version: '2.0.0.1054',
    };

    try {
      const response = await $axios.$request({
        method: 'POST',
        url: completeUrl,
        headers: UPLOAD_CONFIG.HEADERS,
        data: querystring.stringify(postData),
      });

      if (parseInt(response.OK) !== 1 || response.info.includes('error')) {
        throw new Error(`完成上传失败: ${response.info}`);
      }

      return response;
    } catch (error) {
      throw new Error(`完成上传请求失败: ${error}`);
    }
  }

  private async publishVideo(remoteVideos: remoteVideoPart[]): Promise<void> {
    if (remoteVideos.length === 0) {
      throw new Error('没有可发布的视频');
    }

    const publishData = this.buildPublishData(remoteVideos);
    const publishUrl = 'https://member.bilibili.com/x/vu/client/add';

    try {
      const response = await $axios.$request({
        method: 'POST',
        url: publishUrl,
        data: publishData.data,
        params: publishData.params,
        headers: publishData.headers,
      });

      if (response.code !== 0) {
        throw new Error(`发布视频失败: ${response.message}`);
      }

      this.logger.info(`视频发布成功: AV${response.data.aid}, BV${response.data.bvid}`);
    } catch (error) {
      throw new Error(`发布视频请求失败: ${error}`);
    }
  }

  private buildPublishData(remoteVideos: remoteVideoPart[]): any {
    const timestamp = Math.floor(Date.now() / 1000);

    const postData = {
      copyright: this.uploadConfig.copyright,
      cover: '',
      desc: this.uploadConfig.desc,
      no_reprint: 0,
      open_elec: 1,
      source: this.uploadConfig.source,
      tag: this.uploadConfig.tags.join(','),
      tid: this.uploadConfig.tid,
      title: this.uploadConfig.title,
      videos: JSON.stringify(remoteVideos),
      dynamic: this.uploadConfig.dynamic,
    };

    const params = {
      access_key: this.uploadConfig.access_token,
      ts: timestamp,
    };

    return {
      data: postData,
      params,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: global.app.user?.cookies || '',
      },
    };
  }
}
