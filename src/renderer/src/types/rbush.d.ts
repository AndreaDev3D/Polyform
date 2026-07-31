declare module 'rbush' {
  export interface BBox {
    minX: number
    minY: number
    maxX: number
    maxY: number
  }

  export default class RBush<T> {
    constructor(maxEntries?: number)
    insert(item: T): RBush<T>
    load(items: readonly T[]): RBush<T>
    remove(item: T, equals?: (a: T, b: T) => boolean): RBush<T>
    clear(): RBush<T>
    search(box: BBox): T[]
    all(): T[]
    collides(box: BBox): boolean
  }
}
