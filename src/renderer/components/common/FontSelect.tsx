/**
 * FontSelect — a font picker dropdown that groups options into
 *   ★ 收藏  → 最近使用  →  全部字体
 * Each row has a ★ toggle (stopPropagation) so the user can favourite/un-favour
 * without selecting. Favourites and recents are kept in the editing store and
 * persisted to localStorage, so they survive a page refresh.
 *
 * The component only deals in font NAMES; the parent resolves a name to its
 * file path (fonts are passed as {name, path}).
 */
import React from 'react';
import { Box, FormControl, InputLabel, Select, MenuItem } from '@mui/material';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';

export interface FontEntry {
  name: string;
  path: string;
}

interface FontSelectProps {
  label: string;
  value: string;
  fonts: FontEntry[];
  favorites: string[];
  recents: string[];
  onChange: (name: string) => void;
  onToggleFav: (name: string) => void;
  size?: 'small' | 'medium';
  disabled?: boolean;
}

const GROUP_SX = {
  fontWeight: 700,
  fontSize: '0.68rem',
  color: 'text.secondary',
  pointerEvents: 'none',
  backgroundColor: 'action.hover',
} as const;

const FontSelect: React.FC<FontSelectProps> = ({
  label,
  value,
  fonts,
  favorites,
  recents,
  onChange,
  onToggleFav,
  size = 'small',
  disabled = false,
}) => {
  const favSet = new Set(favorites);
  const recSet = new Set(recents);
  const byName = new Map(fonts.map((f) => [f.name, f]));

  const favList = favorites.filter((n) => byName.has(n));
  const recentList = recents.filter((n) => byName.has(n) && !favSet.has(n));
  const restList = fonts.filter((f) => !favSet.has(f.name) && !recSet.has(f.name));

  const labelId = `font-select-${label.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  const renderRow = (name: string) => (
    <MenuItem key={name} value={name} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}>
      <Box sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</Box>
      <Box
        component="span"
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          onToggleFav(name);
        }}
        sx={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer', color: favSet.has(name) ? 'warning.main' : 'action.disabled', ml: 0.5 }}
        title={favSet.has(name) ? '取消收藏' : '收藏此字体'}
      >
        {favSet.has(name) ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
      </Box>
    </MenuItem>
  );

  return (
    <FormControl size={size} fullWidth disabled={disabled}>
      <InputLabel id={labelId}>{label}</InputLabel>
      <Select
        labelId={labelId}
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as string)}
      >
        {favList.length > 0 && [
          <MenuItem key="g-fav" disabled sx={GROUP_SX}>★ 收藏</MenuItem>,
          ...favList.map(renderRow),
        ]}
        {recentList.length > 0 && [
          <MenuItem key="g-rec" disabled sx={GROUP_SX}>最近使用</MenuItem>,
          ...recentList.map(renderRow),
        ]}
        {restList.length > 0 && [
          <MenuItem key="g-all" disabled sx={GROUP_SX}>全部字体</MenuItem>,
          ...restList.map((f) => renderRow(f.name)),
        ]}
        {fonts.length === 0 && <MenuItem value={value} disabled>{value || '（无字体）'}</MenuItem>}
      </Select>
    </FormControl>
  );
};

export default FontSelect;
