import React from 'react';

export interface NoticeContent {
  title: string;
  msg: string;
  icon?: React.ReactNode;
}

export interface NoticeCardProps {
  content: NoticeContent;
  onClose: () => void;
  colors: { bg: string; fg: string; border: string };
}

const NoticeCard: React.FC<NoticeCardProps> = ({ content, onClose, colors }) => {
  return (
    <div
      className="card"
      style={{
        background: colors.bg,
        color: colors.fg,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        maxWidth: 520,
        width: 'min(92%, 520px)',
        padding: '10px 12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {content.icon ?? <i className="fa-solid fa-triangle-exclamation"></i>}
          <strong>{content.title}</strong>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          title="Close"
          style={{ background: 'transparent', border: 'none', color: colors.fg, fontSize: 18, lineHeight: 1, cursor: 'pointer' }}
        >
          ×
        </button>
      </div>
      <div style={{ fontSize: 14, lineHeight: 1.45 }}>{content.msg}</div>
    </div>
  );
};

export default NoticeCard;
