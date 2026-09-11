import axios, { AxiosInstance } from 'axios';

export interface JellyfinServerInfo {
  Id: string;
  ServerName: string;
  Version: string;
}

export interface JellyfinUser {
  Id: string;
  Name: string;
}

export interface JellyfinLibrary {
  Id: string;
  Name: string;
  CollectionType: string;
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  SeriesName?: string;
  SeasonName?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  Overview?: string;
  ProductionYear?: number;
  OfficialRating?: string;
  CommunityRating?: number;
  PrimaryImageAspectRatio?: number;
  ImageTags?: { Primary?: string; Backdrop?: string };
  BackdropImageTags?: string[];
  MediaSources?: Array<{
    Id: string;
    Protocol?: string;
    Path?: string;
    Type?: string;
  }>;
  RunTimeTicks?: number;
  /** Server watch state (§12.1: server UserData preferred). */
  UserData?: { PlaybackPositionTicks?: number; Played?: boolean; LastPlayedDate?: string };
  DateCreated?: string;
}

export class JellyfinClient {
  protected client: AxiosInstance;
  protected baseUrl: string;
  protected accessToken?: string;
  protected userId?: string;

  constructor(baseUrl: string, accessToken?: string, userId?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.accessToken = accessToken;
    this.userId = userId;

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      // Media servers are on the LAN - never route through env/system proxies
      proxy: false,
      headers: this.getHeaders(),
    });
  }

  protected getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // Required by Jellyfin 10.9+ and Emby for AuthenticateByName
      'X-Emby-Authorization':
        'MediaBrowser Client="QY-Player", Device="QY-Player", DeviceId="qy-player-desktop", Version="1.0.0"',
    };
    if (this.accessToken) {
      headers['X-Emby-Token'] = this.accessToken;
    }
    return headers;
  }

  protected updateClientHeaders(): void {
    const headers = this.getHeaders();
    for (const [key, value] of Object.entries(headers)) {
      this.client.defaults.headers.common[key] = value;
    }
  }

  async discover(): Promise<JellyfinServerInfo> {
    const response = await this.client.get('/system/info/public');
    return response.data;
  }

  async authenticate(username: string, password: string): Promise<{ accessToken: string; userId: string }> {
    const response = await this.client.post('/Users/AuthenticateByName', {
      Username: username,
      Pw: password,
    });
    this.accessToken = response.data.AccessToken;
    this.userId = response.data.User.Id;
    this.updateClientHeaders();
    return { accessToken: this.accessToken!, userId: this.userId! };
  }

  async getViews(): Promise<JellyfinLibrary[]> {
    const response = await this.client.get(`/Users/${this.userId}/Views`);
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
      // Fields is a whitelist - poster year/rating and the home page's
      // "recently added" (DateCreated sort) all depend on these being present
      Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,Path,MediaSources,DateCreated,ProductionYear,CommunityRating,Overview',
      ImageTypeLimit: 1,
      EnableImageTypes: 'Primary,Backdrop,Thumb',
      ...options,
    };
    if (parentId) {
      params.ParentId = parentId;
    }
    const response = await this.client.get(`/Users/${this.userId}/Items`, { params });
    return response.data.Items || [];
  }

  async getItemDetails(itemId: string): Promise<JellyfinItem> {
    const response = await this.client.get(`/Users/${this.userId}/Items/${itemId}`, {
      params: {
        Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,Path,MediaSources,Overview,Genres,People',
      },
    });
    return response.data;
  }

  async getContinueWatching(): Promise<JellyfinItem[]> {
    const response = await this.client.get(`/Users/${this.userId}/Items/Resume`, {
      params: {
        Fields: 'PrimaryImageAspectRatio,BasicSyncInfo',
        ImageTypeLimit: 1,
        EnableImageTypes: 'Primary,Backdrop,Thumb',
        MediaTypes: 'Video',
      },
    });
    return response.data.Items || [];
  }

  async getNextUp(seriesId?: string): Promise<JellyfinItem[]> {
    const params: Record<string, unknown> = {
      UserId: this.userId,
      Fields: 'PrimaryImageAspectRatio,BasicSyncInfo',
      ImageTypeLimit: 1,
      EnableImageTypes: 'Primary,Backdrop,Thumb',
    };
    if (seriesId) {
      params.SeriesId = seriesId;
    }
    const response = await this.client.get('/Shows/NextUp', { params });
    return response.data.Items || [];
  }

  getImageUrl(itemId: string, imageType = 'Primary', maxHeight = 500): string {
    return `${this.baseUrl}/Items/${itemId}/Images/${imageType}?maxHeight=${maxHeight}&quality=90`;
  }

  getBackdropUrl(itemId: string, index = 0): string {
    return `${this.baseUrl}/Items/${itemId}/Images/Backdrop/${index}?maxHeight=1080&quality=90`;
  }

  getStreamingUrl(
    itemId: string,
    mediaSourceId: string,
    mode: 'direct' | 'transcode' = 'direct',
    playSessionId?: string
  ): string {
    if (mode === 'transcode') {
      // Server-side transcode to HLS (see emby-client for the auth note)
      const params = new URLSearchParams({
        MediaSourceId: mediaSourceId,
        api_key: this.accessToken || '',
        PlaySessionId: playSessionId || '',
        MaxStreamingBitrate: '8000000',
        SegmentContainer: 'ts',
        VideoCodec: 'h264',
        AudioCodec: 'aac',
      });
      return `${this.baseUrl}/Videos/${itemId}/master.m3u8?${params.toString()}`;
    }
    // Direct play of the original file (Static=true) - client-side decode
    const params = new URLSearchParams({
      MediaSourceId: mediaSourceId,
      api_key: this.accessToken || '',
      Static: 'true',
    });
    return `${this.baseUrl}/Videos/${itemId}/stream?${params.toString()}`;
  }

  /**
   * Report playback progress to the server so that resume position
   * is synced across devices (web, mobile, other clients).
   */
  async reportProgress(
    itemId: string,
    mediaSourceId: string,
    positionTicks: number,
    isFinished: boolean,
    isPaused: boolean,
    playMethod: 'DirectPlay' | 'Transcode' | 'DirectStream' = 'DirectPlay'
  ): Promise<void> {
    const endpoint = isFinished ? '/Sessions/Playing/Stopped' : '/Sessions/Playing/Progress';
    await this.client.post(endpoint, {
      ItemId: itemId,
      MediaSourceId: mediaSourceId,
      PositionTicks: positionTicks,
      IsPaused: isPaused,
      PlayMethod: playMethod,
    });
  }
}
