import React from 'react';

interface TreeNodeProps {
  id: string;
  content: React.ReactNode;
  type: 'root' | 'sub' | 'fail' | 'mode';
  children?: React.ReactNode;
  isExpanded: boolean;
  onToggle: (id: string) => void;
  isSelected?: boolean;
  onSelect?: (id: string) => void;
}

export const TreeNode: React.FC<TreeNodeProps> = ({
  id,
  content,
  type,
  children,
  isExpanded,
  onToggle,
  isSelected = false,
  onSelect,
}) => {
  const hasChildren = !!children && React.Children.count(children) > 0;

  return (
    <li className={hasChildren && isExpanded ? 'is-expanded' : 'is-collapsed'}>
      <div
        className={`node-wrapper ${hasChildren ? 'has-children' : ''}`}
        onClick={() => (onSelect ? onSelect(id) : undefined)}
      >
        <div
          className={`mind-card ${type} ${
            type === 'root'
              ? 'bg-slate-900 text-white border border-slate-800 rounded-xl px-10 py-6 min-w-[320px] max-w-[420px] shadow-lg text-center text-lg relative z-20 transition-all hover:scale-105 hover:shadow-xl hover:z-50 cursor-pointer select-none'
              : 'bg-white border border-slate-200 rounded-lg p-3 min-w-[220px] max-w-[300px] shadow-sm text-left relative z-20 transition-all hover:scale-105 hover:shadow-lg hover:border-brand-500 hover:z-50 whitespace-pre-wrap'
          } ${
            type === 'sub'
              ? 'border-l-[5px] border-l-brand-500'
              : type === 'fail'
              ? 'border-l-[5px] border-l-amber-500'
              : type === 'mode'
              ? 'border-l-[5px] border-l-red-500'
              : ''
          } ${isSelected ? 'ring-2 ring-brand-500' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(id);
            else onSelect?.(id);
          }}
          role="treeitem"
          aria-expanded={hasChildren ? isExpanded : undefined}
        >
          {/* No arrow button, no reserved spacer */}
          {content}
        </div>
      </div>

      {hasChildren && isExpanded && <ul>{children}</ul>}
    </li>
  );
};
