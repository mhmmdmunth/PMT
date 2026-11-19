import React, { useRef, useEffect, useState } from 'react';
import { formatQty2Decimal } from '../utils/excelFormula';

interface SpreadsheetCellProps {
  itemId: string;
  field: string;
  value: any;
  item?: any;
  activeCell?: { itemId: string; field: string } | null;
  editingCell?: { itemId: string; field: string } | null;
  editValue?: string;
  align?: 'left' | 'center' | 'right';
  className?: string;
  inputType?: 'text' | 'number' | 'textarea' | 'select';
  selectOptions?: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  // Standard prop names
  onSelectCell?: (cell: { itemId: string; field: string }) => void;
  onStartEdit?: (cell: { itemId: string; field: string }, initialVal?: string) => void;
  onEditChange?: (val: string) => void;
  onSaveEdit?: (direction?: { row: number; col: number; autoStartEdit?: boolean }) => void;
  onCancelEdit?: () => void;
  onContextMenu?: (e: React.MouseEvent, itemId: string, field: string) => void;
  // Spread useSpreadsheetTable names (when {...spreadsheet} is passed)
  setActiveCell?: (cell: { itemId: string; field: string } | null) => void;
  startEditing?: (cell: { itemId: string; field: string }, initialVal?: string) => void;
  setEditValue?: (val: string) => void;
  saveEditing?: (direction?: { row: number; col: number; autoStartEdit?: boolean }) => void;
  cancelEditing?: () => void;
  setContextMenu?: (menu: any) => void;
  isBatchEditMode?: boolean;
  displayFormatter?: (val: any) => React.ReactNode;
}

export const SpreadsheetCell: React.FC<SpreadsheetCellProps> = ({
  itemId,
  field,
  value,
  item,
  activeCell,
  editingCell,
  editValue = '',
  align = 'left',
  className = '',
  inputType = 'text',
  selectOptions,
  placeholder = '',
  disabled = false,
  readOnly = false,
  isBatchEditMode = false,
  onSelectCell,
  onStartEdit,
  onEditChange,
  onSaveEdit,
  onCancelEdit,
  onContextMenu,
  setActiveCell,
  startEditing,
  setEditValue,
  saveEditing,
  cancelEditing,
  setContextMenu,
  displayFormatter,
}) => {
  const isLocked = disabled || readOnly;
  const isSelected = activeCell?.itemId === itemId && activeCell?.field === field;
  const isEditing = !isLocked && (isBatchEditMode || (editingCell?.itemId === itemId && editingCell?.field === field));
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null);
  const [localVal, setLocalVal] = useState(editValue);

  useEffect(() => {
    if (isEditing) {
      setLocalVal(editValue);
    }
  }, [isEditing, editValue]);

  // Safe callback dispatchers
  const dispatchSelectCell = (cell: { itemId: string; field: string }) => {
    if (typeof onSelectCell === 'function') {
      onSelectCell(cell);
    } else if (typeof setActiveCell === 'function') {
      setActiveCell(cell);
    }
  };

  const dispatchStartEdit = (cell: { itemId: string; field: string }, initialVal?: string) => {
    if (typeof onStartEdit === 'function') {
      onStartEdit(cell, initialVal);
    } else if (typeof startEditing === 'function') {
      startEditing(cell, initialVal);
    }
  };

  const dispatchEditChange = (val: string) => {
    if (typeof onEditChange === 'function') {
      onEditChange(val);
    } else if (typeof setEditValue === 'function') {
      setEditValue(val);
    }
  };

  const isHandlingKeyRef = useRef(false);

  const dispatchSaveEdit = (direction?: { row: number; col: number; autoStartEdit?: boolean }) => {
    if (typeof onSaveEdit === 'function') {
      onSaveEdit(direction);
    } else if (typeof saveEditing === 'function') {
      saveEditing(direction);
    }
  };

  const dispatchCancelEdit = () => {
    if (typeof onCancelEdit === 'function') {
      onCancelEdit();
    } else if (typeof cancelEditing === 'function') {
      cancelEditing();
    }
  };

  const dispatchContextMenu = (e: React.MouseEvent) => {
    if (typeof onContextMenu === 'function') {
      onContextMenu(e, itemId, field);
    } else if (typeof setContextMenu === 'function') {
      setContextMenu({ x: e.clientX, y: e.clientY, item: item || { id: itemId }, field });
    }
  };

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus({ preventScroll: true });
      if ('select' in inputRef.current) {
        inputRef.current.select();
      }
    }
  }, [isEditing]);

  const triggerSaveWithKeyGuard = (direction?: { row: number; col: number; autoStartEdit?: boolean }) => {
    isHandlingKeyRef.current = true;
    dispatchSaveEdit(direction);
    setTimeout(() => {
      isHandlingKeyRef.current = false;
    }, 300);
  };

  const handleBlur = () => {
    console.log('SpreadsheetCell: Blur triggered', { isHandlingKeyRef: isHandlingKeyRef.current });
    if (isHandlingKeyRef.current) {
        console.log('SpreadsheetCell: Blur ignored due to key handling');
        return;
    }
    dispatchSaveEdit();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    console.log('SpreadsheetCell: Key down', e.key);
    if (e.key === 'Enter') {
      console.log('SpreadsheetCell: Enter pressed');
      e.preventDefault();
      e.stopPropagation();
      triggerSaveWithKeyGuard(e.shiftKey ? { row: -1, col: 0, autoStartEdit: false } : { row: 1, col: 0, autoStartEdit: false });
    } else if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      triggerSaveWithKeyGuard(e.shiftKey ? { row: 0, col: -1, autoStartEdit: true } : { row: 0, col: 1, autoStartEdit: true });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      triggerSaveWithKeyGuard({ row: -1, col: 0, autoStartEdit: false });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      triggerSaveWithKeyGuard({ row: 1, col: 0, autoStartEdit: false });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      isHandlingKeyRef.current = true;
      dispatchCancelEdit();
      setTimeout(() => {
        isHandlingKeyRef.current = false;
      }, 150);
    }
    // Arrow keys, Home, End, Backspace, Delete, Ctrl+A/C/V work naturally without interruption
  };

  const alignClass =
    align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : 'text-left';

  // Render Editing Input with stable height matching view mode (exact 32px)
  if (isEditing) {
    return (
      <td className={`p-0 relative z-20 bg-amber-50 h-8 box-border ${className}`}>
        {inputType === 'select' && selectOptions ? (
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            value={editValue}
            onChange={(e) => {
              dispatchEditChange(e.target.value);
              triggerSaveWithKeyGuard();
            }}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            className={`w-full h-8 text-xs px-1.5 bg-amber-50 border-2 border-emerald-600 rounded-none focus:outline-hidden font-medium box-border m-0 leading-none ${alignClass}`}
          >
            {selectOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type={inputType === 'number' ? 'text' : inputType === 'textarea' ? 'text' : inputType}
            value={editValue}
            onChange={(e) => dispatchEditChange(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder={placeholder}
            className={`w-full h-8 text-xs px-2 bg-amber-50 border-2 border-emerald-600 rounded-none focus:outline-hidden font-sans font-medium box-border m-0 leading-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${alignClass}`}
          />
        )}
      </td>
    );
  }

  // Display cell value
  const isPlaceholder = itemId?.startsWith('wi-placeholder-');
  const formattedContent = displayFormatter
    ? displayFormatter(value)
    : field === 'qty'
    ? formatQty2Decimal(value, isPlaceholder)
    : value !== undefined && value !== null && value !== '' && value !== 0
    ? String(value)
    : '';

  return (
    <td
      onClick={(e) => {
        e.stopPropagation();
        dispatchSelectCell({ itemId, field });
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        dispatchSelectCell({ itemId, field });
        if (!isLocked) {
          dispatchStartEdit({ itemId, field });
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dispatchSelectCell({ itemId, field });
        if (!isLocked) {
          dispatchContextMenu(e);
        }
      }}
      title={field === 'itemNo' ? 'Klik sel langsung untuk edit Nomor Item (No.)' : undefined}
      className={`relative px-2 py-0 h-8 text-xs font-sans select-none box-border ${
        isLocked ? 'cursor-not-allowed bg-slate-100/70 opacity-60 text-slate-400' : 'cursor-cell'
      } ${alignClass} ${
        isSelected
          ? 'ring-2 ring-emerald-600 bg-emerald-100/70 text-slate-900 font-semibold z-10'
          : !isLocked ? 'hover:bg-slate-100/80' : ''
      } ${className}`}
    >
      <div className={`h-8 flex items-center ${alignClass === 'text-center' ? 'justify-center' : alignClass === 'text-right' ? 'justify-end' : 'justify-start'} ${inputType === 'textarea' || displayFormatter ? 'max-w-full overflow-hidden truncate' : 'truncate max-w-full'}`}>
        {displayFormatter ? (formattedContent !== undefined && formattedContent !== null ? formattedContent : '') : (formattedContent || <span className="text-slate-300 italic text-[11px]">-</span>)}
      </div>

      {/* Excel active cell handle square in bottom right */}
      {isSelected && (
        <div className="absolute bottom-0 right-0 w-1.5 h-1.5 bg-emerald-600 border border-white rounded-xs z-20 pointer-events-none" />
      )}
    </td>
  );
};
