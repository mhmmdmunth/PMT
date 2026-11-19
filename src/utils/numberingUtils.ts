import { WorkItem } from '../types';

/**
 * Utility helper to determine the hierarchy level of a WorkItem (1 = Area, 2 = Sub-System, 3 = Komponen)
 */
export function getItemLevel(item: WorkItem, categoryItems?: WorkItem[]): 1 | 2 | 3 {
  if (item.itemLevel === 1 || item.isAreaHeader) return 1;
  if (item.itemLevel === 2) return 2;
  if (item.itemLevel === 3) return 3;

  // Infer from parentId if available
  if (item.parentId && categoryItems && categoryItems.length > 0) {
    const parent = categoryItems.find((i) => i.id === item.parentId);
    if (parent) {
      const parentLevel = getItemLevel(parent, categoryItems);
      return parentLevel === 1 ? 2 : 3;
    }
  }

  // Infer from itemNo dot structure
  const parts = (item.itemNo || '').trim().split('.');
  if (parts.length === 1 && (!item.type || item.type.trim() === '')) return 1;
  if (parts.length === 2) return 2;
  if (parts.length >= 3) return 3;

  return 3;
}

/**
 * Finds all descendant IDs (children, grandchildren, etc.) for a given item ID
 */
export function getDescendantIds(allItems: WorkItem[], rootId: string): Set<string> {
  const descendants = new Set<string>();
  const toProcess: string[] = [rootId];

  while (toProcess.length > 0) {
    const currentId = toProcess.pop()!;
    const children = allItems.filter((i) => i.parentId === currentId);
    children.forEach((c) => {
      if (!descendants.has(c.id)) {
        descendants.add(c.id);
        toProcess.push(c.id);
      }
    });
  }

  return descendants;
}

/**
 * Resequences itemNo for all items inside a single category to guarantee strictly sequential order:
 * Level 1 (Area): 1, 2, 3...
 * Level 2 (Sub-System): 1.1, 1.2, 2.1, 2.2...
 * Level 3 (Komponen): 1.1.1, 1.1.2, 2.1.1, 2.1.2...
 * 
 * Preserves custom item order while rebuilding correct hierarchy numbers and parent references.
 */
export function resequenceCategoryItems(
  allItems: WorkItem[],
  categoryId: string,
  forceAutoRenumber: boolean = false
): WorkItem[] {
  const catItems = allItems.filter((i) => i.categoryId === categoryId);
  if (catItems.length === 0) return allItems;

  const otherItems = allItems.filter((i) => i.categoryId !== categoryId);
  const resequencedCatItems: WorkItem[] = [];

  let areaIdx = 0;
  let subIdx = 0;
  let compIdx = 0;

  let currentAreaId: string | undefined = undefined;
  let currentAreaNo = '';
  let currentSubId: string | undefined = undefined;
  let currentSubNo = '';

  catItems.forEach((item) => {
    const lvl = getItemLevel(item, catItems);

    if (lvl === 1 || item.isAreaHeader) {
      areaIdx++;
      const autoAreaNo = String(areaIdx);
      const areaNo = (!forceAutoRenumber && item.itemNo && item.itemNo.trim() !== '' && !item.itemNo.includes('.'))
        ? item.itemNo.trim()
        : autoAreaNo;

      currentAreaId = item.id;
      currentAreaNo = areaNo;
      currentSubId = undefined;
      currentSubNo = '';
      subIdx = 0;
      compIdx = 0;

      resequencedCatItems.push({
        ...item,
        itemNo: areaNo,
        itemLevel: 1,
        isAreaHeader: true,
        parentId: undefined,
      });
    } else if (lvl === 2) {
      subIdx++;
      const autoSubNo = currentAreaNo ? `${currentAreaNo}.${subIdx}` : String(subIdx);
      const subNo = (!forceAutoRenumber && item.itemNo && item.itemNo.trim() !== '')
        ? item.itemNo.trim()
        : autoSubNo;

      currentSubId = item.id;
      currentSubNo = subNo;
      compIdx = 0;

      resequencedCatItems.push({
        ...item,
        itemNo: subNo,
        itemLevel: 2,
        isAreaHeader: false,
        parentId: currentAreaId,
      });
    } else {
      // Level 3 (Component)
      compIdx++;
      const baseNo = currentSubNo || currentAreaNo || '1';
      const autoCompNo = `${baseNo}.${compIdx}`;
      const compNo = (!forceAutoRenumber && item.itemNo && item.itemNo.trim() !== '')
        ? item.itemNo.trim()
        : autoCompNo;

      const parentIdToCheck = currentSubId || currentAreaId;

      resequencedCatItems.push({
        ...item,
        itemNo: compNo,
        itemLevel: 3,
        isAreaHeader: false,
        parentId: parentIdToCheck,
      });
    }
  });

  // Recombine with other categories while preserving category block grouping
  const finalResult: WorkItem[] = [];
  const processedCatIds = new Set<string>();

  allItems.forEach((origItem) => {
    if (origItem.categoryId === categoryId) {
      if (!processedCatIds.has(categoryId)) {
        finalResult.push(...resequencedCatItems);
        processedCatIds.add(categoryId);
      }
    } else {
      if (!processedCatIds.has(origItem.categoryId)) {
        // Keep other category items
        const otherCatItems = otherItems.filter((i) => i.categoryId === origItem.categoryId);
        finalResult.push(...otherCatItems);
        processedCatIds.add(origItem.categoryId);
      }
    }
  });

  // Ensure nothing is lost
  if (!processedCatIds.has(categoryId)) {
    finalResult.push(...resequencedCatItems);
  }

  return finalResult;
}

/**
 * Resequences all categories across the entire project
 */
export function resequenceAllWorkItems(allItems: WorkItem[], forceAutoRenumber: boolean = false): WorkItem[] {
  if (!allItems || allItems.length === 0) return [];

  // Extract unique categoryIds in appearance order
  const categoryIds = Array.from(new Set(allItems.map((i) => i.categoryId || 'cat-1')));
  let currentItems = [...allItems];

  categoryIds.forEach((catId) => {
    currentItems = resequenceCategoryItems(currentItems, catId, forceAutoRenumber);
  });

  return currentItems;
}

/**
 * Calculates the next sequential item number dynamically for Add Modals / Quick Adds
 */
export function getNextItemSequenceNumber(
  allItems: WorkItem[],
  categoryId: string,
  level: 1 | 2 | 3,
  parentId?: string
): string {
  if (!categoryId) return '1';

  const catItems = allItems.filter((i) => i.categoryId === categoryId);
  if (catItems.length === 0) {
    return level === 1 ? '1' : level === 2 ? '1.1' : '1.1.1';
  }

  if (level === 1) {
    const areaItems = catItems.filter((i) => i.itemLevel === 1 || i.isAreaHeader || !i.itemNo.includes('.'));
    let maxNo = 0;
    areaItems.forEach((i) => {
      const num = parseInt(i.itemNo, 10);
      if (!isNaN(num) && num > maxNo) maxNo = num;
    });
    return String(maxNo + 1);
  } else if (level === 2) {
    const parent = allItems.find((i) => i.id === parentId);
    const pNo = parent ? parent.itemNo : '1';
    const siblings = catItems.filter(
      (i) =>
        (parentId ? i.parentId === parentId : !i.parentId) ||
        (i.itemNo.startsWith(`${pNo}.`) && i.itemNo.split('.').length === 2)
    );
    let maxSubNo = 0;
    siblings.forEach((i) => {
      const parts = i.itemNo.split('.');
      if (parts.length >= 2) {
        const subNum = parseInt(parts[1], 10);
        if (!isNaN(subNum) && subNum > maxSubNo) maxSubNo = subNum;
      }
    });
    return `${pNo}.${maxSubNo + 1}`;
  } else {
    const parent = allItems.find((i) => i.id === parentId);
    const pNo = parent ? parent.itemNo : '1.1';
    const siblings = catItems.filter(
      (i) => (parentId ? i.parentId === parentId : !i.parentId) || i.itemNo.startsWith(`${pNo}.`)
    );
    let maxCompNo = 0;
    siblings.forEach((i) => {
      const parts = i.itemNo.split('.');
      if (parts.length >= 3) {
        const compNum = parseInt(parts[2], 10);
        if (!isNaN(compNum) && compNum > maxCompNo) maxCompNo = compNum;
      } else if (parts.length === 2) {
        const compNum = parseInt(parts[1], 10);
        if (!isNaN(compNum) && compNum > maxCompNo) maxCompNo = compNum;
      }
    });
    return `${pNo}.${maxCompNo + 1}`;
  }
}

/**
 * Deletes a single item and all its descendants (children, grandchildren), then automatically
 * resequences the affected category so that all item numbers are strictly sequential without gaps.
 */
export function cascadeDeleteWorkItem(
  allItems: WorkItem[],
  idToDelete: string
): { updatedItems: WorkItem[]; deletedIds: string[] } {
  const targetItem = allItems.find((i) => i.id === idToDelete);
  if (!targetItem) {
    return { updatedItems: allItems, deletedIds: [] };
  }

  const descendantIds = getDescendantIds(allItems, idToDelete);
  const allIdsToDelete = new Set<string>([idToDelete, ...Array.from(descendantIds)]);

  const remainingItems = allItems.filter((i) => !allIdsToDelete.has(i.id));
  const resequencedItems = resequenceCategoryItems(remainingItems, targetItem.categoryId);

  return {
    updatedItems: resequencedItems,
    deletedIds: Array.from(allIdsToDelete),
  };
}

/**
 * Deletes multiple items (and their descendants), then automatically resequences all affected categories.
 */
export function cascadeDeleteWorkItems(
  allItems: WorkItem[],
  idsToDelete: string[]
): { updatedItems: WorkItem[]; deletedIds: string[] } {
  if (!idsToDelete || idsToDelete.length === 0) {
    return { updatedItems: allItems, deletedIds: [] };
  }

  const allIdsToDelete = new Set<string>(idsToDelete);
  const affectedCatIds = new Set<string>();

  idsToDelete.forEach((id) => {
    const item = allItems.find((i) => i.id === id);
    if (item) {
      affectedCatIds.add(item.categoryId);
      const descendants = getDescendantIds(allItems, id);
      descendants.forEach((dId) => allIdsToDelete.add(dId));
    }
  });

  let remainingItems = allItems.filter((i) => !allIdsToDelete.has(i.id));

  affectedCatIds.forEach((catId) => {
    remainingItems = resequenceCategoryItems(remainingItems, catId);
  });

  return {
    updatedItems: remainingItems,
    deletedIds: Array.from(allIdsToDelete),
  };
}

/**
 * Adds a new item and automatically resequences the entire category to ensure strictly sequential numbers.
 */
export function addAndResequenceWorkItem(
  allItems: WorkItem[],
  newItemData: Omit<WorkItem, 'id'>,
  targetInsertIdx?: number
): { updatedItems: WorkItem[]; createdItem: WorkItem } {
  const newId = `wi-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const createdItem: WorkItem = {
    ...newItemData,
    id: newId,
  };

  let listWithNew: WorkItem[];
  if (targetInsertIdx !== undefined && targetInsertIdx >= 0 && targetInsertIdx <= allItems.length) {
    listWithNew = [
      ...allItems.slice(0, targetInsertIdx),
      createdItem,
      ...allItems.slice(targetInsertIdx),
    ];
  } else {
    listWithNew = [...allItems, createdItem];
  }

  const resequenced = resequenceCategoryItems(listWithNew, createdItem.categoryId);
  const finalCreated = resequenced.find((i) => i.id === newId) || createdItem;

  return {
    updatedItems: resequenced,
    createdItem: finalCreated,
  };
}
