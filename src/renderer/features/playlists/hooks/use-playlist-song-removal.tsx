import { closeAllModals, openModal } from '@mantine/modals';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { api } from '/@/renderer/api';
import { useAddToPlaylist } from '/@/renderer/features/playlists/mutations/add-to-playlist-mutation';
import { useRemoveFromPlaylist } from '/@/renderer/features/playlists/mutations/remove-from-playlist-mutation';
import { useReplacePlaylist } from '/@/renderer/features/playlists/mutations/replace-playlist-mutation';
import { useConfirmRemoveFromPlaylist, useCurrentServerId } from '/@/renderer/store';
import { ConfirmModal } from '/@/shared/components/modal/modal';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { useHotkeys } from '/@/shared/hooks/use-hotkeys';
import { Song } from '/@/shared/types/domain-types';

type PlaylistRemovalEntry = {
    type: 'removal';
    fallbackSongIds: string[];
    removedSongs: Array<{
        index: number;
        songId: string;
    }>;
};

type PlaylistReorderEntry = {
    previousPlaylistItemIds: string[];
    type: 'reorder';
};

type PlaylistUndoEntry = PlaylistRemovalEntry | PlaylistReorderEntry;

const playlistUndoQueueMap = new Map<string, PlaylistUndoEntry[]>();
const playlistRemovalInFlightSet = new Set<string>();
const playlistUndoInFlightSet = new Set<string>();
let hasRegisteredUndoExitHandler = false;

const clearUndoQueuesOnExit = () => {
    playlistUndoQueueMap.clear();
    playlistRemovalInFlightSet.clear();
    playlistUndoInFlightSet.clear();
};

const getPlaylistUndoQueueKey = (serverId: string, playlistId: string) =>
    `${serverId}:${playlistId}`;

const isSamePlaylistOrder = (left: string[], right: string[]) =>
    left.length === right.length && left.every((id, index) => id === right[index]);

export const usePlaylistSongRemoval = (args?: { enableUndoHotkey?: boolean }) => {
    const { enableUndoHotkey = false } = args || {};
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const { playlistId } = useParams() as { playlistId?: string };
    const confirmRemoveFromPlaylist = useConfirmRemoveFromPlaylist();
    const addToPlaylistMutation = useAddToPlaylist({});
    const replacePlaylistMutation = useReplacePlaylist({});
    const removeFromPlaylistMutation = useRemoveFromPlaylist();

    if (!hasRegisteredUndoExitHandler && typeof window !== 'undefined') {
        window.addEventListener('beforeunload', clearUndoQueuesOnExit);
        window.addEventListener('unload', clearUndoQueuesOnExit);
        window.addEventListener('pagehide', clearUndoQueuesOnExit);
        hasRegisteredUndoExitHandler = true;
    }

    const undoLastRemoval = useCallback(async () => {
        if (!serverId || !playlistId) return;

        const queueKey = getPlaylistUndoQueueKey(serverId, playlistId);
        if (playlistUndoInFlightSet.has(queueKey)) return;

        const undoQueue = playlistUndoQueueMap.get(queueKey);
        const undoEntry = undoQueue?.[undoQueue.length - 1];

        if (!undoEntry) return;

        playlistUndoInFlightSet.add(queueKey);

        try {
            if (undoEntry.type === 'reorder') {
                const playlistSongsRes = await api.controller.getPlaylistSongList({
                    apiClientProps: { serverId },
                    query: { id: playlistId },
                });
                const playlistItems = playlistSongsRes?.items ?? [];
                const songIdByPlaylistItemId = new Map<string, string>();
                const restoredSongIds: string[] = [];
                const restoredPlaylistItemIds = new Set<string>();

                playlistItems.forEach((song) => {
                    if (!song.playlistItemId || !song.id) {
                        return;
                    }
                    songIdByPlaylistItemId.set(song.playlistItemId, song.id);
                });

                undoEntry.previousPlaylistItemIds.forEach((playlistItemId) => {
                    const songId = songIdByPlaylistItemId.get(playlistItemId);
                    if (!songId) {
                        return;
                    }
                    restoredSongIds.push(songId);
                    restoredPlaylistItemIds.add(playlistItemId);
                });

                // Keep newly added items by appending their current-order IDs.
                playlistItems.forEach((song) => {
                    if (!song.id) {
                        return;
                    }
                    if (song.playlistItemId && restoredPlaylistItemIds.has(song.playlistItemId)) {
                        return;
                    }
                    restoredSongIds.push(song.id);
                });

                if (restoredSongIds.length === 0) {
                    return;
                }

                await replacePlaylistMutation.mutateAsync({
                    apiClientProps: { serverId },
                    body: { songId: restoredSongIds },
                    query: { id: playlistId },
                });
            } else if (undoEntry.removedSongs.length > 0) {
                const playlistSongsRes = await api.controller.getPlaylistSongList({
                    apiClientProps: { serverId },
                    query: { id: playlistId },
                });
                const nextSongIds = (playlistSongsRes?.items ?? [])
                    .map((song) => song.id)
                    .filter((id): id is string => Boolean(id));

                const restoredSongIds = [...nextSongIds];
                const sortedRemovedSongs = [...undoEntry.removedSongs].sort(
                    (a, b) => a.index - b.index,
                );

                sortedRemovedSongs.forEach((removedSong) => {
                    const insertIndex = Math.max(
                        0,
                        Math.min(removedSong.index, restoredSongIds.length),
                    );
                    restoredSongIds.splice(insertIndex, 0, removedSong.songId);
                });

                await replacePlaylistMutation.mutateAsync({
                    apiClientProps: { serverId },
                    body: { songId: restoredSongIds },
                    query: { id: playlistId },
                });
            } else if (undoEntry.fallbackSongIds.length > 0) {
                await addToPlaylistMutation.mutateAsync({
                    apiClientProps: { serverId },
                    body: { songId: undoEntry.fallbackSongIds },
                    query: { id: playlistId },
                });
            } else {
                return;
            }

            undoQueue?.pop();
            if (undoQueue?.length === 0) {
                playlistUndoQueueMap.delete(queueKey);
            }
            toast.success({
                message: t('action.undo', { postProcess: 'sentenceCase' }),
            });
        } catch (err: any) {
            toast.error({
                message: err.message,
                title: t('error.genericError', { postProcess: 'sentenceCase' }),
            });
        } finally {
            playlistUndoInFlightSet.delete(queueKey);
        }
    }, [addToPlaylistMutation, playlistId, replacePlaylistMutation, serverId, t]);

    useHotkeys(
        enableUndoHotkey
            ? [
                  [
                      'mod+z',
                      () => {
                          const activeElement = document.activeElement as HTMLElement | null;
                          const tagName = activeElement?.tagName?.toLowerCase();
                          const isInput =
                              tagName === 'input' ||
                              tagName === 'textarea' ||
                              activeElement?.getAttribute('contenteditable') === 'true';

                          if (isInput) return;
                          void undoLastRemoval();
                      },
                  ],
              ]
            : [],
    );

    const recordPlaylistReorder = useCallback(
        (previousPlaylistItemIds: string[], nextPlaylistItemIds: string[]) => {
            if (!serverId || !playlistId) return;

            const previousIds = previousPlaylistItemIds.filter(Boolean);
            const nextIds = nextPlaylistItemIds.filter(Boolean);

            if (previousIds.length === 0 || nextIds.length === 0) {
                return;
            }

            if (isSamePlaylistOrder(previousIds, nextIds)) {
                return;
            }

            const queueKey = getPlaylistUndoQueueKey(serverId, playlistId);
            const undoQueue = playlistUndoQueueMap.get(queueKey) ?? [];
            undoQueue.push({
                previousPlaylistItemIds: [...previousIds],
                type: 'reorder',
            });
            playlistUndoQueueMap.set(queueKey, undoQueue);
        },
        [playlistId, serverId],
    );

    const removePlaylistItems = useCallback(
        async (
            playlistItemIds: string[],
            songIds: string[],
            options?: { onSuccess?: () => void },
        ) => {
            if (playlistItemIds.length === 0 || !serverId || !playlistId) {
                return;
            }

            const queueKey = getPlaylistUndoQueueKey(serverId, playlistId);
            if (playlistRemovalInFlightSet.has(queueKey)) return;

            playlistRemovalInFlightSet.add(queueKey);

            try {
                let removedSongs: PlaylistRemovalEntry['removedSongs'] = [];
                const targetPlaylistItemIds = new Set(playlistItemIds);

                try {
                    const playlistSongsRes = await api.controller.getPlaylistSongList({
                        apiClientProps: { serverId },
                        query: { id: playlistId },
                    });

                    removedSongs = (playlistSongsRes?.items ?? [])
                        .map((song, index) => ({
                            index,
                            playlistItemId: song.playlistItemId,
                            songId: song.id,
                        }))
                        .filter(
                            (
                                song,
                            ): song is {
                                index: number;
                                playlistItemId: string;
                                songId: string;
                            } => {
                                const playlistItemId = song.playlistItemId;
                                const songId = song.songId;
                                return (
                                    typeof playlistItemId === 'string' &&
                                    typeof songId === 'string' &&
                                    targetPlaylistItemIds.has(playlistItemId)
                                );
                            },
                        )
                        .map((song) => ({
                            index: song.index,
                            songId: song.songId,
                        }));
                } catch {
                    // Position capture is best-effort; keep fallback undo when unavailable.
                }

                if (removedSongs.length === 0) {
                    removedSongs = songIds.map((songId, index) => ({
                        index: Number.MAX_SAFE_INTEGER - songIds.length + index,
                        songId,
                    }));
                }

                await removeFromPlaylistMutation.mutateAsync({
                    apiClientProps: { serverId },
                    query: {
                        id: playlistId,
                        songId: playlistItemIds,
                    },
                });

                const undoQueue = playlistUndoQueueMap.get(queueKey) ?? [];
                undoQueue.push({
                    fallbackSongIds: songIds,
                    removedSongs,
                    type: 'removal',
                });
                playlistUndoQueueMap.set(queueKey, undoQueue);

                options?.onSuccess?.();
                toast.success({
                    message: `${t('action.removeFromPlaylist', {
                        postProcess: 'sentenceCase',
                    })} (${t('action.undo', { postProcess: 'sentenceCase' })}: Ctrl+Z)`,
                });
            } catch (err: any) {
                toast.error({
                    message: err.message,
                    title: t('error.genericError', { postProcess: 'sentenceCase' }),
                });
            } finally {
                playlistRemovalInFlightSet.delete(queueKey);
                closeAllModals();
            }
        },
        [playlistId, removeFromPlaylistMutation, serverId, t],
    );

    const removeSongsFromPlaylist = useCallback(
        (songs: Song[], options?: { onSuccess?: () => void }) => {
            if (!playlistId) return;

            const playlistItemIds = songs
                .map((song) => song.playlistItemId)
                .filter((id): id is string => Boolean(id));
            const songIds = songs.map((song) => song.id).filter((id): id is string => Boolean(id));

            if (playlistItemIds.length === 0 || songIds.length === 0) return;

            if (!confirmRemoveFromPlaylist) {
                void removePlaylistItems(playlistItemIds, songIds, options);
                return;
            }

            openModal({
                children: (
                    <ConfirmModal
                        onConfirm={() => {
                            void removePlaylistItems(playlistItemIds, songIds, options);
                        }}
                    >
                        <Text>{t('common.areYouSure', { postProcess: 'sentenceCase' })}</Text>
                    </ConfirmModal>
                ),
                title: t('action.removeFromPlaylist', { postProcess: 'sentenceCase' }),
            });
        },
        [confirmRemoveFromPlaylist, playlistId, removePlaylistItems, t],
    );

    return { recordPlaylistReorder, removeSongsFromPlaylist, undoLastRemoval };
};
