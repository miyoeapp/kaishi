export class UndoManager {
  constructor(limit = 50) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }

  record(snapshot) {
    const previous = this.undoStack.at(-1);
    if (previous && previous.value === snapshot.value && previous.start === snapshot.start && previous.end === snapshot.end) return;
    this.undoStack.push({ ...snapshot });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(current) {
    const target = this.undoStack.pop();
    if (!target) return null;
    this.redoStack.push({ ...current });
    return target;
  }

  redo(current) {
    const target = this.redoStack.pop();
    if (!target) return null;
    this.undoStack.push({ ...current });
    return target;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}

