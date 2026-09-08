import { JellyfinClient, JellyfinServerInfo, JellyfinLibrary, JellyfinItem } from './jellyfin-client';

export class EmbyClient extends JellyfinClient {
  async discover(): Promise<JellyfinServerInfo> {
    const response = await this.client.get('/emby/system/info/public');
    return response.data;
  }

  async authenticate(username: string, password: string): Promise<{ accessToken: string; userId: string }> {
    const response = await this.client.post('/emby/Users/AuthenticateByName', {
      Username: username,
      Pw: password,
    });
    this.accessToken = response.data.AccessToken;
    this.userId = response.data.User.Id;
    this.updateClientHeaders();
    return { accessToken: this.accessToken!, userId: this.userId! };
  }

  async getViews(): Promise<JellyfinLibrary[]> {
    const response = await this.client.get(`/emby/Users/${this.userId}/Views`);
    return response.data.Items || [];
  }

  async getItems(
    parentId?: string,
    options?: {
      includeItemTypes?: string;
      recursive?: boolean;
      sortBy?: string;
      sortOrder?: string;
      limit?: number;
      startIndex?: number;
      searchTerm?: string;
    }
  ): Promise<JellyfinItem[]> {
    const params: Record<string, unknown> = {
      UserId: this.userId,
      Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,Path,MediaSources,DateCreated,ProductionYear,CommunityRating,Overview',
      ImageTypeLimit: 1,
      EnableImageTypes: 'Primary,Backdrop,Thumb',
      ...options,
    };
    if (parentId) {
      params.ParentId = parentId;
    }
    const response = await this.client.get(`/emby/Users/${this.userId}/Items`, { params });
    return response.data.Items || [];
  }

  async getItemDetails(itemId: string): Promise<JellyfinItem> {
    const response = await this.client.get(`/emby/Users/${this.userId}/Items/${itemId}`, {
      params: {
        Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,Path,MediaSources,DateCreated,ProductionYear,CommunityRating,Overview,Genres,People',
      },
    });
    return response.data;
  }

  async getContinueWatching(): Promise<JellyfinItem[]> {
    const response = await this.client.get(`/emby/Users/${this.userId}/Items/Resume`, {
      params: {
        Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,DateCreated',
        ImageTypeLimit: 1,
        EnableImageTypes: 'Primary,Backdrop,Thumb',
        MediaTypes: 'Video',
      },
    });
    return response.data.Items || [];
  }

  getImageUrl(itemId: string, imageType = 'Primary', maxHeight = 500): string {
    return `${this.baseUrl}/emby/Items/${itemId}/Images/${imageType}?maxHeight=${maxHeight}&quality=90`;
  }

  getBackdropUrl(itemId: string, index = 0): string {
    return `${this.baseUrl}/emby/Items/${itemId}/Images/Backdrop/${index}?maxHeight=1080&quality=90`;
  }

  getStreamingUrl(
    itemId: string,
    mediaSourceId: string,
    mode: 'direct' | 'transcode' = 'direct',
    playSessionId?: string
  ): string {
    if (mode === 'transcode') {
      // Server-side transcode to HLS. The client decodes the transcoded
      // stream (h264/aac, low CPU); the server does the heavy decoding.
      // NOTE: segment requests carry no api_key - pass the token via
      // stream-lavf-o headers (see PlayerCore.loadFile).
      const params = new URLSearchParams({
        MediaSourceId: mediaSourceId,
        api_key: this.accessToken || '',
        PlaySessionId: playSessionId || '',
        MaxStreamingBitrate: '8000000',
        SegmentContainer: 'ts',
        VideoCodec: 'h264',
        AudioCodec: 'aac',
        TranscodingMaxAudioChannels: '2',
      });
      return `${this.baseUrl}/emby/Videos/${itemId}/master.m3u8?${params.toString()}`;
    }
    // Direct play of the original file (Static=true): client-side decode,
    // lossless quality, best when the client can decode the codec.
    const params = new URLSearchParams({
      MediaSourceId: mediaSourceId,
      api_key: this.accessToken || '',
      Static: 'true',
    });
    return `${this.baseUrl}/emby/Videos/${itemId}/stream?${params.toString()}`;
  }

  async reportProgress(
    itemId: string,
    mediaSourceId: string,
    positionTicks: number,
    isFinished: boolean,
    isPaused: boolean,
    playMethod: 'DirectPlay' | 'Transcode' | 'DirectStream' = 'DirectPlay'
  ): Promise<void> {
    const endpoint = isFinished ? '/emby/Sessions/Playing/Stopped' : '/emby/Sessions/Playing/Progress';
    await this.client.post(endpoint, {
      ItemId: itemId,
      MediaSourceId: mediaSourceId,
      PositionTicks: positionTicks,
      IsPaused: isPaused,
      PlayMethod: playMethod,
    });
  }
}
