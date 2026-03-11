import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useItemListPagination } from '/@/renderer/components/item-list/item-list-pagination/use-item-list-pagination';
import { ItemListHandle } from '/@/renderer/components/item-list/types';
import { useListContext } from '/@/renderer/context/list-context';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import { playlistsQueries } from '/@/renderer/features/playlists/api/playlists-api';
import { PlaylistDetailAlbumView } from '/@/renderer/features/playlists/components/playlist-detail-album-view';
import { usePlaylistTrackList } from '/@/renderer/features/playlists/hooks/use-playlist-track-list';
import { useReplacePlaylist } from '/@/renderer/features/playlists/mutations/replace-playlist-mutation';
import { useCurrentServer, useCurrentServerId, useListSettings } from '/@/renderer/store';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { toast } from '/@/shared/components/toast/toast';
import {
    LibraryItem,
    PlaylistSongListQuery,
    PlaylistSongListResponse,
    Song,
} from '/@/shared/types/domain-types';
import {
    ItemListKey,
    ListDisplayType,
    ListPaginationType,
    TableColumn,
} from '/@/shared/types/types';

const PlaylistDetailSongListTable = lazy(() =>
    import('/@/renderer/features/playlists/components/playlist-detail-song-list-table').then(
        (module) => ({
            default: module.PlaylistDetailSongListTable,
        }),
    ),
);

const PlaylistDetailSongListEditTable = lazy(() =>
    import('/@/renderer/features/playlists/components/playlist-detail-song-list-table').then(
        (module) => ({
            default: module.PlaylistDetailSongListEditTable,
        }),
    ),
);

const PlaylistDetailSongListGrid = lazy(() =>
    import('/@/renderer/features/playlists/components/playlist-detail-song-list-grid').then(
        (module) => ({
            default: module.PlaylistDetailSongListGrid,
        }),
    ),
);

const getPlaylistSongKey = (song: Song) => song.playlistItemId || song.id;

export const PlaylistDetailSongListContent = () => {
    const { playlistId } = useParams() as { playlistId: string };
    const server = useCurrentServer();
    const queryClient = useQueryClient();

    const playlistSongsQuery = useSuspenseQuery(
        playlistsQueries.songList({
            query: {
                id: playlistId,
            },
            serverId: server?.id,
        }),
    );

    useEffect(() => {
        const handleRefresh = async (payload: { key: string }) => {
            if (
                payload.key !== ItemListKey.PLAYLIST_SONG &&
                payload.key !== ItemListKey.PLAYLIST_ALBUM
            ) {
                return;
            }

            const queryKey = playlistsQueries.songList({
                query: {
                    id: playlistId,
                },
                serverId: server?.id,
            }).queryKey;

            await queryClient.invalidateQueries({ queryKey });
            await queryClient.refetchQueries({ queryKey });
        };

        eventEmitter.on('ITEM_LIST_REFRESH', handleRefresh);

        return () => {
            eventEmitter.off('ITEM_LIST_REFRESH', handleRefresh);
        };
    }, [playlistId, queryClient, server?.id]);

    return (
        <Suspense fallback={<Spinner container />}>
            <PlaylistDetailSongList data={playlistSongsQuery.data} />
        </Suspense>
    );
};

export type OverridePlaylistSongListQuery = Omit<Partial<PlaylistSongListQuery>, 'id'>;

interface PlaylistDetailSongListViewProps {
    data: PlaylistSongListResponse;
    items?: Song[];
}

export const PlaylistDetailSongListView = ({ data, items }: PlaylistDetailSongListViewProps) => {
    const server = useCurrentServer();
    const { display, itemsPerPage, pagination, table } = useListSettings(ItemListKey.PLAYLIST_SONG);
    const { currentPage, onChange: onPageChange } = useItemListPagination();
    const isPaginated = pagination === ListPaginationType.PAGINATED;

    const paginationProps = isPaginated
        ? {
              currentPage,
              itemsPerPage,
              onPageChange,
          }
        : undefined;

    switch (display) {
        case ListDisplayType.GRID: {
            return (
                <PlaylistDetailSongListGrid
                    data={data}
                    items={items}
                    serverId={server.id}
                    {...paginationProps}
                />
            );
        }
        case ListDisplayType.TABLE: {
            return (
                <PlaylistDetailSongListTable
                    autoFitColumns={table.autoFitColumns}
                    columns={table.columns}
                    data={data}
                    enableAlternateRowColors={table.enableAlternateRowColors}
                    enableHeader={table.enableHeader}
                    enableHorizontalBorders={table.enableHorizontalBorders}
                    enableRowHoverHighlight={table.enableRowHoverHighlight}
                    enableVerticalBorders={table.enableVerticalBorders}
                    items={items}
                    serverId={server.id}
                    size={table.size}
                    {...paginationProps}
                />
            );
        }
        default:
            return null;
    }
};

export const PlaylistDetailSongListEdit = ({ data }: { data: PlaylistSongListResponse }) => {
    const { t } = useTranslation();
    const { playlistId } = useParams() as { playlistId: string };
    const server = useCurrentServer();
    const serverId = useCurrentServerId();
    const { display, table } = useListSettings(ItemListKey.PLAYLIST_SONG);
    const replacePlaylistMutation = useReplacePlaylist({});
    const {
        isPending: isReplacePlaylistPending,
        mutate: mutateReplacePlaylist,
    } = replacePlaylistMutation;

    const [localData, setLocalData] = useState<PlaylistSongListResponse>(data);

    const tableRef = useRef<ItemListHandle | null>(null);
    const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const syncedOrderSignatureRef = useRef<string>('');

    // Listen for playlist reorder events
    useEffect(() => {
        const reorderItemsById = (
            previousData: PlaylistSongListResponse,
            reorderedIds: string[],
        ): PlaylistSongListResponse => {
            const previousItems = previousData.items ?? [];
            const itemMap = new Map(previousItems.map((song) => [getPlaylistSongKey(song), song]));
            const reorderedItems = reorderedIds
                .map((id) => itemMap.get(id))
                .filter((item): item is NonNullable<typeof item> => item !== undefined);

            return {
                ...previousData,
                items: reorderedItems,
            };
        };

        const handleReorder = (payload: {
            edge: 'bottom' | 'top' | null;
            playlistId: string;
            sourceIds: string[];
            targetId: string;
        }) => {
            // Only handle events for this playlist
            if (payload.playlistId !== playlistId) {
                return;
            }

            setLocalData((prev) => {
                if (!prev?.items || !payload.edge) {
                    return prev;
                }

                // Create a list of IDs in current order
                const currentIds = prev.items.map((item) => getPlaylistSongKey(item));
                const sourceIdSet = new Set(payload.sourceIds);
                const sourceIdsInCurrentOrder = currentIds.filter((id) => sourceIdSet.has(id));

                if (sourceIdsInCurrentOrder.length === 0) {
                    return prev;
                }

                // Find the target index
                const targetIndex = currentIds.indexOf(payload.targetId);
                if (targetIndex === -1) {
                    return prev;
                }

                // Remove all source IDs from their current positions
                const idsWithoutSources = currentIds.filter((id) => !sourceIdSet.has(id));

                // Calculate the insertion index based on the original target position
                const sourcesBeforeTarget = sourceIdsInCurrentOrder.filter((id) => {
                    const sourceIndex = currentIds.indexOf(id);
                    return sourceIndex !== -1 && sourceIndex < targetIndex;
                }).length;

                // Calculate the insert index in the filtered list
                const insertIndexInFiltered =
                    payload.edge === 'top'
                        ? targetIndex - sourcesBeforeTarget
                        : targetIndex - sourcesBeforeTarget + 1;

                // Ensure insertIndex is within bounds
                const insertIndex = Math.max(
                    0,
                    Math.min(insertIndexInFiltered, idsWithoutSources.length),
                );

                // Insert source IDs at the calculated position
                const reorderedIds = [
                    ...idsWithoutSources.slice(0, insertIndex),
                    ...sourceIdsInCurrentOrder,
                    ...idsWithoutSources.slice(insertIndex),
                ];

                return reorderItemsById(prev, reorderedIds);
            });
        };

        const handleMoveToTop = (payload: { playlistId: string; sourceIds: string[] }) => {
            if (payload.playlistId !== playlistId) {
                return;
            }

            setLocalData((prev) => {
                if (!prev?.items?.length || payload.sourceIds.length === 0) {
                    return prev;
                }

                const currentIds = prev.items.map((item) => getPlaylistSongKey(item));
                const sourceIdSet = new Set(payload.sourceIds);
                const sourceIdsInCurrentOrder = currentIds.filter((id) => sourceIdSet.has(id));

                if (sourceIdsInCurrentOrder.length === 0) {
                    return prev;
                }

                const idsWithoutSources = currentIds.filter((id) => !sourceIdSet.has(id));
                const reorderedIds = [...sourceIdsInCurrentOrder, ...idsWithoutSources];

                return reorderItemsById(prev, reorderedIds);
            });
        };

        const handleMoveToBottom = (payload: { playlistId: string; sourceIds: string[] }) => {
            if (payload.playlistId !== playlistId) {
                return;
            }

            setLocalData((prev) => {
                if (!prev?.items?.length || payload.sourceIds.length === 0) {
                    return prev;
                }

                const currentIds = prev.items.map((item) => getPlaylistSongKey(item));
                const sourceIdSet = new Set(payload.sourceIds);
                const sourceIdsInCurrentOrder = currentIds.filter((id) => sourceIdSet.has(id));

                if (sourceIdsInCurrentOrder.length === 0) {
                    return prev;
                }

                const idsWithoutSources = currentIds.filter((id) => !sourceIdSet.has(id));
                const reorderedIds = [...idsWithoutSources, ...sourceIdsInCurrentOrder];

                return reorderItemsById(prev, reorderedIds);
            });
        };

        eventEmitter.on('PLAYLIST_REORDER', handleReorder);
        eventEmitter.on('PLAYLIST_MOVE_TO_TOP', handleMoveToTop);
        eventEmitter.on('PLAYLIST_MOVE_TO_BOTTOM', handleMoveToBottom);

        return () => {
            eventEmitter.off('PLAYLIST_REORDER', handleReorder);
            eventEmitter.off('PLAYLIST_MOVE_TO_TOP', handleMoveToTop);
            eventEmitter.off('PLAYLIST_MOVE_TO_BOTTOM', handleMoveToBottom);
        };
    }, [playlistId]);

    // Keep edit-mode local data in sync with server changes (delete/undo) without
    // discarding unsaved local ordering.
    useEffect(() => {
        setLocalData((prev) => {
            const incomingItems = data?.items ?? [];
            const previousItems = prev?.items ?? [];

            const incomingByKey = new Map(
                incomingItems.map((song) => [getPlaylistSongKey(song), song]),
            );
            const preservedOrderItems = previousItems
                .filter((song) => incomingByKey.has(getPlaylistSongKey(song)))
                .map((song) => incomingByKey.get(getPlaylistSongKey(song)) ?? song);

            const preservedKeys = new Set(preservedOrderItems.map(getPlaylistSongKey));
            const appendedIncomingItems = incomingItems.filter(
                (song) => !preservedKeys.has(getPlaylistSongKey(song)),
            );

            const mergedItems = [...preservedOrderItems, ...appendedIncomingItems];
            const isSameOrderAndLength =
                mergedItems.length === previousItems.length &&
                mergedItems.every(
                    (song, index) =>
                        getPlaylistSongKey(song) === getPlaylistSongKey(previousItems[index]),
                );

            if (isSameOrderAndLength) {
                return prev;
            }

            return {
                ...data,
                items: mergedItems,
            };
        });
    }, [data]);

    const localOrderSignature = useMemo(() => {
        return (localData.items ?? []).map((song) => getPlaylistSongKey(song)).join('|');
    }, [localData.items]);

    const remoteOrderSignature = useMemo(() => {
        return (data?.items ?? []).map((song) => getPlaylistSongKey(song)).join('|');
    }, [data?.items]);

    useEffect(() => {
        if (!playlistId || !serverId) {
            return;
        }

        if (localOrderSignature === remoteOrderSignature) {
            syncedOrderSignatureRef.current = localOrderSignature;
            return;
        }

        if (localOrderSignature === syncedOrderSignatureRef.current) {
            return;
        }

        if (isReplacePlaylistPending) {
            return;
        }

        const songIds = (localData.items ?? [])
            .map((song) => song.id)
            .filter((id): id is string => Boolean(id));
        if (songIds.length === 0) {
            return;
        }

        if (autoSaveTimeoutRef.current) {
            clearTimeout(autoSaveTimeoutRef.current);
        }

        const targetOrderSignature = localOrderSignature;
        autoSaveTimeoutRef.current = setTimeout(() => {
            mutateReplacePlaylist(
                {
                    apiClientProps: { serverId },
                    body: {
                        songId: songIds,
                    },
                    query: {
                        id: playlistId,
                    },
                },
                {
                    onError: (err) => {
                        toast.error({
                            message: err.message,
                            title: t('error.genericError', { postProcess: 'sentenceCase' }),
                        });
                    },
                    onSuccess: () => {
                        syncedOrderSignatureRef.current = targetOrderSignature;
                    },
                },
            );
        }, 500);

        return () => {
            if (autoSaveTimeoutRef.current) {
                clearTimeout(autoSaveTimeoutRef.current);
                autoSaveTimeoutRef.current = null;
            }
        };
    }, [
        isReplacePlaylistPending,
        localData.items,
        localOrderSignature,
        mutateReplacePlaylist,
        playlistId,
        remoteOrderSignature,
        serverId,
        t,
    ]);

    const { setListData } = useListContext();
    const playlistColumns = useMemo(
        () => table.columns.filter((column) => column.id !== TableColumn.PLAYLIST_REORDER),
        [table.columns],
    );

    useEffect(() => {
        setListData?.(localData.items);
    }, [localData, setListData]);

    switch (display) {
        case ListDisplayType.GRID:
        case ListDisplayType.TABLE: {
            return (
                <PlaylistDetailSongListEditTable
                    autoFitColumns={table.autoFitColumns}
                    columns={playlistColumns}
                    data={localData}
                    enableAlternateRowColors={table.enableAlternateRowColors}
                    enableHeader={table.enableHeader}
                    enableHorizontalBorders={table.enableHorizontalBorders}
                    enableRowHoverHighlight={table.enableRowHoverHighlight}
                    enableVerticalBorders={table.enableVerticalBorders}
                    ref={tableRef}
                    serverId={server.id}
                    size={table.size}
                />
            );
        }
        default:
            return null;
    }
};

const PlaylistDetailTrackView = ({ data }: { data: PlaylistSongListResponse }) => {
    const { isSmartPlaylist } = useListContext();

    if (isSmartPlaylist) {
        return <PlaylistDetailTrackViewContent data={data} />;
    }

    return <PlaylistDetailSongListEdit data={data} />;
};

const PlaylistDetailTrackViewContent = ({ data }: { data: PlaylistSongListResponse }) => {
    const { sortedAndFilteredSongs } = usePlaylistTrackList(data);
    return <PlaylistDetailSongListView data={data} items={sortedAndFilteredSongs} />;
};

const PlaylistDetailSongList = ({ data }: { data: PlaylistSongListResponse }) => {
    const { displayMode } = useListContext();

    if (displayMode === LibraryItem.ALBUM) {
        return <PlaylistDetailAlbumView data={data} />;
    }

    return <PlaylistDetailTrackView data={data} />;
};
