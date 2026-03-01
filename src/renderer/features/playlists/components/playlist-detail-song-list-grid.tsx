import { forwardRef, useMemo } from 'react';
import { useEffect } from 'react';

import { useGridRows } from '/@/renderer/components/item-list/helpers/use-grid-rows';
import { useItemListScrollPersist } from '/@/renderer/components/item-list/helpers/use-item-list-scroll-persist';
import { ItemGridList } from '/@/renderer/components/item-list/item-grid-list/item-grid-list';
import { ItemListWithPagination } from '/@/renderer/components/item-list/item-list-pagination/item-list-pagination';
import { ItemControls, ItemListGridComponentProps } from '/@/renderer/components/item-list/types';
import { useListContext } from '/@/renderer/context/list-context';
import { usePlaylistSongListFilters } from '/@/renderer/features/playlists/hooks/use-playlist-song-list-filters';
import { usePlaylistSongRemoval } from '/@/renderer/features/playlists/hooks/use-playlist-song-removal';
import { useSearchTermFilter } from '/@/renderer/features/shared/hooks/use-search-term-filter';
import { searchLibraryItems } from '/@/renderer/features/shared/utils';
import { useGeneralSettings, useListSettings } from '/@/renderer/store';
import { sortSongList } from '/@/shared/api/utils';
import {
    LibraryItem,
    PlaylistSongListQuery,
    PlaylistSongListResponse,
    Song,
} from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

interface PlaylistDetailSongListGridProps
    extends Omit<ItemListGridComponentProps<PlaylistSongListQuery>, 'query'> {
    currentPage?: number;
    data: PlaylistSongListResponse;
    items?: Song[];
    itemsPerPage?: number;
    onPageChange?: (page: number) => void;
}

export const PlaylistDetailSongListGrid = forwardRef<any, PlaylistDetailSongListGridProps>(
    ({
        currentPage,
        data,
        items: itemsProp,
        itemsPerPage,
        onPageChange,
        saveScrollOffset = true,
    }) => {
        const { removeSongsFromPlaylist } = usePlaylistSongRemoval({ enableUndoHotkey: true });
        const { handleOnScrollEnd, scrollOffset } = useItemListScrollPersist({
            enabled: saveScrollOffset,
        });

        const { searchTerm } = useSearchTermFilter();
        const { query } = usePlaylistSongListFilters();

        const songDataFromData = useMemo(() => {
            let list = data?.items || [];
            if (searchTerm) {
                list = searchLibraryItems(list, searchTerm, LibraryItem.SONG);
                return list;
            }
            return sortSongList(list, query.sortBy, query.sortOrder);
        }, [data?.items, searchTerm, query.sortBy, query.sortOrder]);

        const { setListData } = useListContext();
        const songData = itemsProp ?? songDataFromData;

        useEffect(() => {
            if (itemsProp == null && setListData) {
                setListData(songDataFromData);
            }
        }, [itemsProp, songDataFromData, setListData]);

        const gridProps = useListSettings(ItemListKey.PLAYLIST_SONG).grid;

        const rows = useGridRows(
            LibraryItem.PLAYLIST_SONG,
            ItemListKey.PLAYLIST_SONG,
            gridProps.size,
        );
        const { enableGridMultiSelect } = useGeneralSettings();
        const overrideControls: Partial<ItemControls> = useMemo(() => {
            return {
                onDelete: ({ internalState }) => {
                    if (!internalState) return;

                    const currentSongs = internalState
                        .getData()
                        .filter(
                            (item): item is Song =>
                                typeof item === 'object' &&
                                item !== null &&
                                'id' in item &&
                                'playlistItemId' in item &&
                                typeof (item as Song).id === 'string',
                        );

                    const currentPlaylistItemIds = new Set(
                        currentSongs
                            .map((item) => item.playlistItemId)
                            .filter((id): id is string => Boolean(id)),
                    );

                    const selectedSongs = internalState
                        .getSelected()
                        .filter(
                            (item): item is Song =>
                                typeof item === 'object' &&
                                item !== null &&
                                'id' in item &&
                                'playlistItemId' in item &&
                                typeof (item as Song).id === 'string',
                        );

                    if (selectedSongs.length === 0) return;

                    const selectedSongsInCurrentData = selectedSongs.filter((song) =>
                        currentPlaylistItemIds.has(song.playlistItemId ?? ''),
                    );

                    if (selectedSongsInCurrentData.length === 0) return;

                    const selectedPlaylistItemIdSet = new Set(
                        selectedSongsInCurrentData
                            .map((song) => song.playlistItemId)
                            .filter((id): id is string => Boolean(id)),
                    );
                    const firstSelectedIndex = currentSongs.findIndex((song) =>
                        selectedPlaylistItemIdSet.has(song.playlistItemId ?? ''),
                    );
                    const deletedPlaylistItemIds = new Set(
                        selectedSongsInCurrentData
                            .map((song) => song.playlistItemId)
                            .filter((id): id is string => Boolean(id)),
                    );

                    removeSongsFromPlaylist(selectedSongsInCurrentData, {
                        onSuccess: () => {
                            let attempts = 0;
                            const maxAttempts = 30;

                            const trySetNextSelection = () => {
                                const latestSongs = internalState
                                    .getData()
                                    .filter(
                                        (item): item is Song =>
                                            typeof item === 'object' &&
                                            item !== null &&
                                            'id' in item &&
                                            'playlistItemId' in item &&
                                            typeof (item as Song).id === 'string',
                                    );

                                const stillHasDeletedSongs = latestSongs.some((song) =>
                                    deletedPlaylistItemIds.has(song.playlistItemId ?? ''),
                                );

                                if (stillHasDeletedSongs && attempts < maxAttempts) {
                                    attempts += 1;
                                    setTimeout(trySetNextSelection, 50);
                                    return;
                                }

                                if (latestSongs.length === 0 || firstSelectedIndex < 0) {
                                    internalState.clearSelected();
                                    return;
                                }

                                const targetIndex = Math.min(
                                    firstSelectedIndex,
                                    latestSongs.length - 1,
                                );
                                const nextSelection = latestSongs[targetIndex];

                                if (nextSelection) {
                                    internalState.setSelected([nextSelection]);
                                } else {
                                    internalState.clearSelected();
                                }
                            };

                            setTimeout(trySetNextSelection, 0);
                        },
                    });
                },
            };
        }, [removeSongsFromPlaylist]);

        const isPaginated =
            typeof currentPage === 'number' &&
            typeof itemsPerPage === 'number' &&
            typeof onPageChange === 'function';
        const totalCount = songData.length;
        const pageCount = Math.max(1, Math.ceil(totalCount / (itemsPerPage ?? 1)));
        const paginatedData = useMemo(() => {
            if (!isPaginated || currentPage == null || itemsPerPage == null) return songData;
            const start = currentPage * itemsPerPage;
            return songData.slice(start, start + itemsPerPage);
        }, [currentPage, isPaginated, itemsPerPage, songData]);
        const dataToRender = isPaginated ? paginatedData : songData;

        const grid = (
            <ItemGridList
                data={dataToRender}
                enableMultiSelect={enableGridMultiSelect}
                gap={gridProps.itemGap}
                initialTop={{
                    to: scrollOffset ?? 0,
                    type: 'offset',
                }}
                itemsPerRow={gridProps.itemsPerRowEnabled ? gridProps.itemsPerRow : undefined}
                itemType={LibraryItem.PLAYLIST_SONG}
                onScrollEnd={handleOnScrollEnd}
                overrideControls={overrideControls}
                rows={rows}
                size={gridProps.size}
            />
        );

        if (isPaginated && itemsPerPage != null) {
            return (
                <ItemListWithPagination
                    currentPage={currentPage!}
                    itemsPerPage={itemsPerPage}
                    onChange={onPageChange!}
                    pageCount={pageCount}
                    totalItemCount={totalCount}
                >
                    {grid}
                </ItemListWithPagination>
            );
        }

        return grid;
    },
);
