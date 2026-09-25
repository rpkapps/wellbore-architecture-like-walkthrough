import { GripVerticalIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button as AriaButton, DropIndicator, GridList, GridListItem, useDragAndDrop, type Key } from 'react-aria-components';

/**
 * A list the user reorders by dragging a row's grip (or, from the keyboard,
 * by focusing the grip and pressing Enter, the arrows and Enter again).
 * Rows can hold their own buttons, switches and fields.
 */
export function SortableList<T extends { id: string }>({
  label,
  items,
  itemLabel,
  onReorder,
  deps = [],
  children,
}: {
  label: string;
  items: T[];
  itemLabel: (item: T) => string;
  /** the ids in their new order */
  onReorder: (ids: string[]) => void;
  /** values the rows render from besides the items themselves (rows are cached per item) */
  deps?: unknown[];
  children: (item: T, index: number) => ReactNode;
}) {
  const { dragAndDropHooks } = useDragAndDrop({
    getItems: (keys) => [...keys].map((k) => ({ 'text/plain': String(k) })),
    getAllowedDropOperations: () => ['move'],
    onReorder(e) {
      const moving = new Set<Key>(e.keys);
      const rest = items.map((x) => x.id).filter((id) => !moving.has(id));
      let at = rest.indexOf(String(e.target.key));
      if (e.target.dropPosition === 'after') at++;
      rest.splice(at, 0, ...items.filter((x) => moving.has(x.id)).map((x) => x.id));
      onReorder(rest);
    },
    renderDropIndicator: (target) => <DropIndicator target={target} className="-my-px h-0.5 rounded-full outline-none data-drop-target:bg-primary" />,
  });
  return (
    <GridList aria-label={label} items={items} dragAndDropHooks={dragAndDropHooks} dependencies={deps} keyboardNavigationBehavior="tab" className="flex flex-col gap-0.5 outline-none">
      {(item) => {
        const i = items.indexOf(item);
        return (
          <GridListItem
            id={item.id}
            textValue={itemLabel(item)}
            className="flex min-w-0 items-center gap-1 rounded-md outline-none data-dragging:opacity-40 data-focus-visible:ring-2 data-focus-visible:ring-ring data-hovered:bg-accent/40"
          >
            <AriaButton
              slot="drag"
              aria-label={`Drag ${itemLabel(item)} to reorder`}
              className="flex h-7 w-5 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground outline-none data-focus-visible:ring-2 data-focus-visible:ring-ring data-hovered:text-foreground data-pressed:cursor-grabbing"
            >
              <GripVerticalIcon className="size-4" />
            </AriaButton>
            {children(item, i)}
          </GridListItem>
        );
      }}
    </GridList>
  );
}
