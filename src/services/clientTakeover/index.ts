// src/services/clientTakeover/index.ts
// 全应用唯一的共享 facade：共享代码只从这里拿客户端接管的能力与类型，不直接 import 平台目录。
// 只有两行含平台名（两条 import 的模块路径与原始导出名）；其余导出都是平台无关别名。

import { isClientTakeoverSong, buildClientTakeoverQueueIds, buildClientTakeoverDeckSrc, buildClientTakeoverSong, isClientTakeoverAvailable, neteaseClientService as clientTakeoverService } from '../onlineMusic/netease/client/neteaseClientService';
import type { NeteaseClientConnectionState as ClientTakeoverConnectionState, NeteaseClientPlaybackState as ClientTakeoverPlaybackState, NeteaseClientCapabilities as ClientTakeoverCapabilities, NeteaseClientError as ClientTakeoverError, NeteaseClientTrack as ClientTakeoverTrack, NeteaseClientSnapshot as ClientTakeoverSnapshot, NeteaseClientStatus as ClientTakeoverStatus, NeteaseClientCommandResult as ClientTakeoverCommandResult, NeteaseClientPlaySongInput as ClientTakeoverPlaySongInput, NeteaseClientPreloadApi as ClientTakeoverPreloadApi, NeteaseClientClockAnchor as ClientTakeoverClockAnchor } from '../onlineMusic/netease/client/types';
import type { NeteaseClientService as ClientTakeoverService } from '../onlineMusic/netease/client/neteaseClientService';

export { isClientTakeoverSong, buildClientTakeoverQueueIds, buildClientTakeoverDeckSrc, buildClientTakeoverSong, isClientTakeoverAvailable, clientTakeoverService };
export type { ClientTakeoverConnectionState, ClientTakeoverPlaybackState, ClientTakeoverCapabilities, ClientTakeoverError, ClientTakeoverTrack, ClientTakeoverSnapshot, ClientTakeoverStatus, ClientTakeoverCommandResult, ClientTakeoverPlaySongInput, ClientTakeoverPreloadApi, ClientTakeoverClockAnchor, ClientTakeoverService };
