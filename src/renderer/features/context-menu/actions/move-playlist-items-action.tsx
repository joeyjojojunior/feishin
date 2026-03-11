import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useListContext } from '/@/renderer/context/list-context';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { Song } from '/@/shared/types/domain-types';

interface MovePlaylistItemsActionProps {
    items: Song[];
}

const getPlaylistSongKey = (song: Song | unknown): null | string => {
    if (!song || typeof song !== 'object') {
        return null;
    }

    if ('playlistItemId' in song && (song as { playlistItemId?: string }).playlistItemId) {
        return (song as { playlistItemId?: string }).playlistItemId ?? null;
    }

    if ('id' in song && (song as { id?: string }).id) {
        return (song as { id?: string }).id ?? null;
    }

    return null;
};

export const MovePlaylistItemsAction = ({ items }: MovePlaylistItemsActionProps) => {
    const { t } = useTranslation();
    const { playlistId } = useParams() as { playlistId?: string };
    const { isSmartPlaylist } = useListContext();

    const sourceIds = useMemo(() => {
        const ids = items
            .map((song) => getPlaylistSongKey(song))
            .filter((id): id is string => Boolean(id));

        return Array.from(new Set(ids));
    }, [items]);

    const isReorderEnabled = !isSmartPlaylist && Boolean(playlistId) && sourceIds.length > 0;

    const handleMoveToTop = useCallback(() => {
        if (!playlistId || !isReorderEnabled) {
            return;
        }

        eventEmitter.emit('PLAYLIST_MOVE_TO_TOP', {
            playlistId,
            sourceIds,
        });
    }, [isReorderEnabled, playlistId, sourceIds]);

    const handleMoveToBottom = useCallback(() => {
        if (!playlistId || !isReorderEnabled) {
            return;
        }

        eventEmitter.emit('PLAYLIST_MOVE_TO_BOTTOM', {
            playlistId,
            sourceIds,
        });
    }, [isReorderEnabled, playlistId, sourceIds]);

    if (!isReorderEnabled) {
        return null;
    }

    return (
        <>
            <ContextMenu.Item leftIcon="arrowUpToLine" onSelect={handleMoveToTop}>
                {t('page.contextMenu.moveToTop', { postProcess: 'sentenceCase' })}
            </ContextMenu.Item>
            <ContextMenu.Item leftIcon="arrowDownToLine" onSelect={handleMoveToBottom}>
                {t('page.contextMenu.moveToBottom', { postProcess: 'sentenceCase' })}
            </ContextMenu.Item>
        </>
    );
};
