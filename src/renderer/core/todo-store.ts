/* SPDX-License-Identifier: GPL-3.0-or-later */
type Todo = { id: number; text: string; done: boolean };
type State = { revision: number; counter: number; items: Todo[] };
type Result = { ok: boolean; error?: string; state?: State };
type API = {
  todoGet(): Promise<State>;
  todoMutate(args: Record<string, unknown>): Promise<Result>;
  onTodoState(callback: (state: State) => void): () => void;
};
export class TodoStore {
  private state: State = { revision: -1, counter: 0, items: [] };
  readonly conversationTitle = '全部会话 · 本机保存';
  constructor(
    private api: API,
    private changed: () => void,
  ) {
    api.onTodoState((state) => this.accept(state));
  }
  async load(): Promise<void> {
    this.accept(await this.api.todoGet());
  }
  get todoItems(): Todo[] {
    return this.state.items;
  }
  get todoIdCounter(): number {
    return this.state.counter;
  }
  private accept(state: State): void {
    if (state.revision <= this.state.revision) return;
    this.state = state;
    this.changed();
  }
  async handleTodo(args: Record<string, unknown>): Promise<Result> {
    const result = await this.api.todoMutate(args);
    if (result.state) this.accept(result.state);
    return result;
  }
}
