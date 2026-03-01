import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { usePlaylistSongRemoval } from '/@/renderer/features/playlists/hooks/use-playlist-song-removal';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { Song } from '/@/shared/types/domain-types';

interface RemoveFromPlaylistActionProps {
    items: Song[];
}

export const RemoveFromPlaylistAction = ({ items }: RemoveFromPlaylistActionProps) => {
    const { t } = useTranslation();
    const { playlistId } = useParams() as { playlistId?: string };
    const { removeSongsFromPlaylist } = usePlaylistSongRemoval();

    const { ids } = useMemo(() => {
        const ids = items.map((item) => item.playlistItemId).filter((id) => id !== undefined);
        return { ids };
    }, [items]);

    if (ids.length === 0 || !playlistId) return null;

    return (
        <ContextMenu.Item
            leftIcon="remove"
            onSelect={() => {
                removeSongsFromPlaylist(items);
            }}
        >
            {t('action.removeFromPlaylist', { postProcess: 'sentenceCase' })}
        </ContextMenu.Item>
    );
};
