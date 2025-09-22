import React from 'react';

export interface SearchBarProps {
  value: string;
  canSearch: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
}

export const SearchBar: React.FC<SearchBarProps> = ({ value, canSearch, onChange, onSubmit }) => {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div className="field">
        <span className="label">Flight #</span>
        <input
          className="input"
          type="text"
          placeholder="e.g. AAL100"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <button className="button search-btn" type="submit" disabled={!canSearch} aria-label="Search">
        <i className="fa-solid fa-magnifying-glass"></i>
        <span className="btn-text">Search</span>
      </button>
    </form>
  );
};

export default SearchBar;
