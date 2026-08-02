const ENGINES = Object.freeze({
  hyperkernel: "Hyperkernel",
  crud: "Traditional CRUD",
});
const EVENT_PAGE_SIZE = 1_000;

const template = document.createElement("template");
template.innerHTML = `
  <header class="app-header">
    <div class="brand-group">
      <p class="eyebrow">SQLite single-writer experiment</p>
      <h1>Todo storage lab</h1>
      <p class="lede">
        Run the same workflow against an event-driven kernel and traditional CRUD.
      </p>
    </div>

    <fieldset class="engine-picker">
      <legend>Storage engine</legend>
      <div class="engine-options">
        <input
          type="radio"
          id="engine-hyperkernel"
          name="engine"
          value="hyperkernel"
          checked
        >
        <label for="engine-hyperkernel">Hyperkernel</label>
        <input
          type="radio"
          id="engine-crud"
          name="engine"
          value="crud"
        >
        <label for="engine-crud">Traditional CRUD</label>
      </div>
    </fieldset>
  </header>

  <main class="app-main" data-app-main>
    <section class="context-bar" aria-labelledby="context-title">
      <div class="context-copy">
        <div class="context-heading">
          <span class="status-badge" data-status-badge>Live</span>
          <h2 id="context-title" data-context-title>Live Hyperkernel data</h2>
        </div>
        <p data-context-description>
          Mutations append an event and update the todo projection atomically.
        </p>
      </div>
      <button class="button button--secondary" type="button" data-return-live hidden>
        Return to live
      </button>
    </section>

    <div class="notice" data-notice hidden>
      <span class="notice-spinner" data-notice-spinner aria-hidden="true"></span>
      <p data-notice-text></p>
      <button class="button button--secondary button--compact" type="button" data-retry hidden>
        Try again
      </button>
    </div>

    <div class="workspace">
      <div class="workspace-grid">
        <section class="panel todo-panel" aria-labelledby="todos-title" data-todo-panel>
          <header class="panel-header">
            <div>
              <h2 id="todos-title">Tasks</h2>
              <p data-todo-count>0 open · 0 total</p>
            </div>
          </header>

          <form class="add-form" data-add-form>
            <label for="new-todo">New todo</label>
            <div class="add-row">
              <input
                id="new-todo"
                name="title"
                type="text"
                maxlength="500"
                autocomplete="off"
                placeholder="What needs to be done?"
                required
                data-title-input
              >
              <button class="button button--primary" type="submit" data-add-button>
                Add todo
              </button>
            </div>
            <p class="form-help" data-form-help>
              This writes to the selected engine only.
            </p>
          </form>

          <div class="historical-lock" data-historical-lock hidden>
            <p>Historical snapshots are read-only. Return to live data to make changes.</p>
          </div>

          <div class="list-loading" data-list-loading hidden>
            <span class="skeleton skeleton--check" aria-hidden="true"></span>
            <span class="skeleton skeleton--text" aria-hidden="true"></span>
            <span class="visually-hidden">Loading todos.</span>
          </div>

          <div class="empty-state" data-empty-state hidden>
            <p class="empty-title" data-empty-title>No todos yet</p>
            <p data-empty-description>Add the first task to start this comparison.</p>
          </div>

          <ul class="todo-list" role="list" data-todo-list></ul>
        </section>

        <aside class="panel event-panel" aria-labelledby="events-title" data-event-panel>
          <header class="panel-header event-header">
            <div>
              <h2 id="events-title">Event log</h2>
              <p data-event-count>0 events recorded</p>
            </div>
            <span class="head-position" data-head-position>#0</span>
          </header>

          <div class="timeline-control">
            <div class="timeline-labels">
              <label for="history-position">History position</label>
              <output for="history-position" data-position-output>Live</output>
            </div>
            <input
              id="history-position"
              name="history-position"
              type="range"
              min="0"
              max="0"
              step="1"
              value="0"
              disabled
              data-position-input
            >
            <div class="timeline-limits" aria-hidden="true">
              <span>0</span>
              <span data-position-maximum>0</span>
            </div>
          </div>

          <div class="event-empty" data-event-empty>
            <p>No events yet. Create a todo to begin the timeline.</p>
          </div>
          <ol class="event-list" role="list" data-event-list></ol>
          <nav class="event-pager" aria-label="Event log pages" data-event-pager hidden>
            <button class="button button--secondary button--compact" type="button" data-events-older>
              Older events
            </button>
            <button class="button button--secondary button--compact" type="button" data-events-newer>
              Newer events
            </button>
          </nav>
        </aside>
      </div>
    </div>

    <footer class="app-footer">
      <p>Two models. One SQLite writer each. The same todo contract.</p>
    </footer>

    <p class="visually-hidden" aria-live="polite" aria-atomic="true" data-announcer></p>
  </main>
`;

class TodoComparison extends HTMLElement {
  #engine = "hyperkernel";
  #todos = [];
  #events = [];
  #latestPosition = 0;
  #hasEarlierEvents = false;
  #hasLaterEvents = false;
  #eventPageAfter = null;
  #eventPageLimit = EVENT_PAGE_SIZE;
  #viewPosition = null;
  #loading = true;
  #hasLoaded = false;
  #error = null;
  #pending = null;
  #refreshController = null;
  #mutationController = null;
  #lifecycleController = null;
  #historyTimer = null;
  #retryFocus = null;
  #elements = null;

  connectedCallback() {
    if (!this.firstElementChild) {
      this.append(template.content.cloneNode(true));
      this.#collectElements();
    }

    this.#lifecycleController?.abort();
    this.#lifecycleController = new AbortController();
    const options = { signal: this.#lifecycleController.signal };

    this.addEventListener(
      "submit",
      (event) => this.#handleSubmit(event),
      options,
    );
    this.addEventListener(
      "change",
      (event) => this.#handleChange(event),
      options,
    );
    this.addEventListener(
      "click",
      (event) => this.#handleClick(event),
      options,
    );
    this.#elements.positionInput.addEventListener(
      "input",
      (event) => this.#handleHistoryInput(event),
      options,
    );
    this.#elements.titleInput.addEventListener(
      "input",
      () => this.#elements.titleInput.setCustomValidity(""),
      options,
    );

    this.#render();
    void this.#refresh();
  }

  disconnectedCallback() {
    this.#lifecycleController?.abort();
    this.#refreshController?.abort();
    this.#mutationController?.abort();
    if (this.#historyTimer !== null) {
      clearTimeout(this.#historyTimer);
    }
  }

  #collectElements() {
    const element = (selector) => {
      const match = this.querySelector(selector);
      if (!(match instanceof HTMLElement)) {
        throw new Error(`Missing Todo UI element: ${selector}`);
      }
      return match;
    };

    const input = (selector) => {
      const match = this.querySelector(selector);
      if (!(match instanceof HTMLInputElement)) {
        throw new Error(`Missing Todo UI input: ${selector}`);
      }
      return match;
    };

    this.#elements = {
      appMain: element("[data-app-main]"),
      statusBadge: element("[data-status-badge]"),
      contextTitle: element("[data-context-title]"),
      contextDescription: element("[data-context-description]"),
      returnLive: element("[data-return-live]"),
      notice: element("[data-notice]"),
      noticeSpinner: element("[data-notice-spinner]"),
      noticeText: element("[data-notice-text]"),
      retry: element("[data-retry]"),
      todoPanel: element("[data-todo-panel]"),
      todoCount: element("[data-todo-count]"),
      addForm: element("[data-add-form]"),
      titleInput: input("[data-title-input]"),
      addButton: element("[data-add-button]"),
      formHelp: element("[data-form-help]"),
      historicalLock: element("[data-historical-lock]"),
      listLoading: element("[data-list-loading]"),
      emptyState: element("[data-empty-state]"),
      emptyTitle: element("[data-empty-title]"),
      emptyDescription: element("[data-empty-description]"),
      todoList: element("[data-todo-list]"),
      eventPanel: element("[data-event-panel]"),
      eventCount: element("[data-event-count]"),
      headPosition: element("[data-head-position]"),
      positionInput: input("[data-position-input]"),
      positionOutput: element("[data-position-output]"),
      positionMaximum: element("[data-position-maximum]"),
      eventEmpty: element("[data-event-empty]"),
      eventList: element("[data-event-list]"),
      eventPager: element("[data-event-pager]"),
      eventsOlder: element("[data-events-older]"),
      eventsNewer: element("[data-events-newer]"),
      announcer: element("[data-announcer]"),
    };
  }

  #handleSubmit(event) {
    if (event.target !== this.#elements.addForm) return;
    event.preventDefault();
    void this.#createTodo();
  }

  #handleChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;

    if (target.name === "engine") {
      void this.#changeEngine(target.value);
      return;
    }

    if (target.matches("[data-todo-toggle]")) {
      const id = target.dataset.todoId;
      if (id !== undefined) {
        void this.#setCompleted(id, target.checked);
      }
    }
  }

  #handleClick(event) {
    const origin = event.target;
    if (!(origin instanceof Element)) return;

    const deleteButton = origin.closest("[data-delete-todo]");
    if (deleteButton instanceof HTMLButtonElement) {
      const id = deleteButton.dataset.todoId;
      if (id !== undefined) void this.#deleteTodo(id);
      return;
    }

    const eventButton = origin.closest("[data-event-position]");
    if (eventButton instanceof HTMLButtonElement) {
      const position = Number(eventButton.dataset.eventPosition);
      if (Number.isSafeInteger(position) && position >= 0) {
        void this.#selectHistory(position);
      }
      return;
    }

    if (origin.closest("[data-events-older]")) {
      void this.#changeEventPage("older");
      return;
    }

    if (origin.closest("[data-events-newer]")) {
      void this.#changeEventPage("newer");
      return;
    }

    if (origin.closest("[data-return-live]")) {
      void this.#returnToLive();
      return;
    }

    if (origin.closest("[data-retry]")) {
      void this.#retry();
    }
  }

  #handleHistoryInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (this.#pending !== null) {
      this.#render();
      return;
    }
    const position = Number(target.value);
    if (!Number.isSafeInteger(position) || position < 0) return;

    this.#beginViewTransition();
    this.#viewPosition = position;

    if (this.#historyTimer !== null) clearTimeout(this.#historyTimer);
    this.#historyTimer = setTimeout(async () => {
      this.#historyTimer = null;
      await this.#refresh();
      if (this.#error !== null) {
        this.#elements.retry.focus();
      } else {
        this.#focusHistoryPosition();
      }
    }, 120);
    this.#render();
  }

  async #changeEngine(engine) {
    if (
      !Object.hasOwn(ENGINES, engine) || engine === this.#engine ||
      this.#pending !== null
    ) {
      this.#render();
      return;
    }

    this.#beginViewTransition();
    this.#engine = engine;
    this.#viewPosition = null;
    this.#todos = [];
    this.#events = [];
    this.#latestPosition = 0;
    this.#hasEarlierEvents = false;
    this.#hasLaterEvents = false;
    this.#eventPageAfter = null;
    this.#eventPageLimit = EVENT_PAGE_SIZE;
    this.#announce(`${ENGINES[engine]} selected.`);
    this.#render();
    await this.#refresh();
    this.#focusEngine(engine);
  }

  async #selectHistory(position) {
    if (this.#engine !== "hyperkernel" || this.#pending !== null) return;
    this.#beginViewTransition();
    this.#viewPosition = Math.min(position, this.#latestPosition);
    this.#render();
    await this.#refresh();
    this.#focusAfterNavigation();
  }

  async #returnToLive() {
    if (this.#viewPosition === null || this.#pending !== null) return;
    this.#beginViewTransition();
    this.#viewPosition = null;
    this.#eventPageAfter = null;
    this.#eventPageLimit = EVENT_PAGE_SIZE;
    this.#announce("Returned to live data.");
    this.#render();
    await this.#refresh();
    this.#focusAfterNavigation();
  }

  async #changeEventPage(direction) {
    if (
      this.#engine !== "hyperkernel" || this.#loading ||
      this.#pending !== null || this.#events.length === 0
    ) {
      return;
    }

    const first = Number(this.#events[0]?.position);
    const last = Number(this.#events.at(-1)?.position);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return;

    if (direction === "older") {
      if (!this.#hasEarlierEvents) return;
      const limit = Math.min(EVENT_PAGE_SIZE, first - 1);
      this.#eventPageAfter = first - 1 - limit;
      this.#eventPageLimit = limit;
    } else if (direction === "newer") {
      if (!this.#hasLaterEvents) return;
      this.#eventPageAfter = last;
      this.#eventPageLimit = EVENT_PAGE_SIZE;
    } else {
      return;
    }

    this.#retryFocus = { type: "event-pager", direction };
    await this.#refresh();
    if (this.#error !== null) {
      this.#elements.retry.focus();
      return;
    }

    const loadedFirst = this.#events[0]?.position;
    const loadedLast = this.#events.at(-1)?.position;
    if (loadedFirst !== undefined && loadedLast !== undefined) {
      this.#announce(`Loaded events ${loadedFirst} through ${loadedLast}.`);
    }
    this.#retryFocus = null;
    this.#focusEventPager(direction);
  }

  #beginViewTransition() {
    this.#refreshController?.abort();
    if (this.#historyTimer !== null) {
      clearTimeout(this.#historyTimer);
      this.#historyTimer = null;
    }
    this.#todos = [];
    this.#retryFocus = null;
    this.#error = null;
    this.#hasLoaded = false;
    this.#loading = true;
  }

  #resetEventPage() {
    this.#eventPageAfter = null;
    this.#eventPageLimit = EVENT_PAGE_SIZE;
  }

  async #retry() {
    const retryFocus = this.#retryFocus;
    await this.#refresh();
    if (
      this.#error === null && retryFocus?.type === "event-pager"
    ) {
      this.#retryFocus = null;
      this.#focusEventPager(retryFocus.direction);
      return;
    }
    this.#focusAfterNavigation();
  }

  async #refresh() {
    this.#refreshController?.abort();
    const controller = new AbortController();
    this.#refreshController = controller;
    this.#loading = true;
    this.#error = null;
    this.#render();

    try {
      const todosUrl = new URL(`/api/${this.#engine}/todos`, location.origin);
      if (this.#engine === "hyperkernel" && this.#viewPosition !== null) {
        todosUrl.searchParams.set("at", String(this.#viewPosition));
      }

      const requests = [this.#request(todosUrl, {}, controller.signal)];
      if (this.#engine === "hyperkernel") {
        const eventsUrl = new URL(
          "/api/hyperkernel/events",
          location.origin,
        );
        if (this.#eventPageAfter !== null) {
          eventsUrl.searchParams.set("after", String(this.#eventPageAfter));
          eventsUrl.searchParams.set("limit", String(this.#eventPageLimit));
        }
        requests.push(
          this.#request(
            eventsUrl,
            {},
            controller.signal,
          ),
        );
      }

      const [todoPayload, eventPayload] = await Promise.all(requests);
      if (controller.signal.aborted) return;

      this.#todos = Array.isArray(todoPayload?.todos) ? todoPayload.todos : [];

      if (this.#engine === "hyperkernel") {
        this.#events = Array.isArray(eventPayload?.events)
          ? eventPayload.events
          : [];
        const latest = Number(eventPayload?.latestPosition);
        this.#latestPosition = Number.isSafeInteger(latest) && latest >= 0
          ? latest
          : this.#inferLatestPosition(this.#events);
        this.#hasEarlierEvents = eventPayload?.hasEarlierEvents === true;
        this.#hasLaterEvents = eventPayload?.hasLaterEvents === true;

        if (!this.#hasLaterEvents) {
          this.#eventPageAfter = null;
          this.#eventPageLimit = EVENT_PAGE_SIZE;
        }

        if (
          this.#viewPosition !== null &&
          this.#viewPosition > this.#latestPosition
        ) {
          this.#viewPosition = this.#latestPosition;
        }
      } else {
        this.#events = [];
        this.#latestPosition = 0;
        this.#hasEarlierEvents = false;
        this.#hasLaterEvents = false;
        this.#eventPageAfter = null;
        this.#eventPageLimit = EVENT_PAGE_SIZE;
      }

      this.#hasLoaded = true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.#error = error instanceof Error
        ? error.message
        : "The todo data could not be loaded.";
      this.#hasLoaded = true;
    } finally {
      if (this.#refreshController === controller) {
        this.#refreshController = null;
        this.#loading = false;
        this.#render();
      }
    }
  }

  async #createTodo() {
    const title = this.#elements.titleInput.value.trim();
    if (title.length === 0) {
      this.#elements.titleInput.setCustomValidity("Enter a todo title.");
      this.#elements.titleInput.reportValidity();
      return;
    }

    this.#elements.titleInput.setCustomValidity("");
    if (this.#viewPosition !== null || this.#pending !== null) {
      return;
    }

    this.#pending = { type: "create" };
    this.#error = null;
    this.#render();

    try {
      const payload = await this.#mutate(
        `/api/${this.#engine}/todos`,
        "POST",
        { title },
      );
      this.#elements.titleInput.value = "";
      if (payload?.todo) this.#todos = [...this.#todos, payload.todo];
      this.#announce(`Added ${title}.`);
      this.#resetEventPage();
      await this.#refresh();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.#error = error instanceof Error
        ? error.message
        : "The todo could not be added.";
    } finally {
      this.#pending = null;
      this.#render();
      this.#focusAfterNavigation();
    }
  }

  async #setCompleted(id, completed) {
    if (this.#viewPosition !== null || this.#pending !== null) return;

    const previousTodos = this.#todos;
    this.#todos = this.#todos.map((todo) =>
      String(todo.id) === id ? { ...todo, completed } : todo
    );
    this.#pending = { type: "toggle", id };
    this.#error = null;
    this.#render();

    try {
      await this.#mutate(
        `/api/${this.#engine}/todos/${encodeURIComponent(id)}`,
        "PATCH",
        { completed },
      );
      this.#announce(completed ? "Todo completed." : "Todo reopened.");
      this.#pending = null;
      this.#resetEventPage();
      await this.#refresh();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.#todos = previousTodos;
      this.#error = error instanceof Error
        ? error.message
        : "The todo could not be updated.";
    } finally {
      this.#pending = null;
      this.#render();
      if (this.#error !== null) {
        this.#elements.retry.focus();
      } else {
        this.#focusTodoControl(id, "[data-todo-toggle]");
      }
    }
  }

  async #deleteTodo(id) {
    if (this.#viewPosition !== null || this.#pending !== null) return;

    const todo = this.#todos.find((candidate) => String(candidate.id) === id);
    let deleted = false;
    this.#pending = { type: "delete", id };
    this.#error = null;
    this.#render();

    try {
      await this.#mutate(
        `/api/${this.#engine}/todos/${encodeURIComponent(id)}`,
        "DELETE",
      );
      this.#todos = this.#todos.filter((candidate) =>
        String(candidate.id) !== id
      );
      this.#announce(todo?.title ? `Deleted ${todo.title}.` : "Todo deleted.");
      deleted = true;
      this.#resetEventPage();
      await this.#refresh();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.#error = error instanceof Error
        ? error.message
        : "The todo could not be deleted.";
    } finally {
      this.#pending = null;
      this.#render();
      if (deleted) {
        this.#elements.titleInput.focus();
      } else if (this.#error !== null) {
        this.#elements.retry.focus();
      } else {
        this.#focusTodoControl(id, "[data-delete-todo]");
      }
    }
  }

  async #mutate(pathname, method, body) {
    this.#mutationController?.abort();
    const controller = new AbortController();
    this.#mutationController = controller;

    try {
      const init = { method };
      if (body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      return await this.#request(
        new URL(pathname, location.origin),
        init,
        controller.signal,
      );
    } finally {
      if (this.#mutationController === controller) {
        this.#mutationController = null;
      }
    }
  }

  async #request(url, init, signal) {
    const response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        ...init.headers,
      },
      signal,
    });

    const contentType = response.headers.get("content-type") ?? "";
    let payload;
    if (response.status !== 204 && contentType.includes("application/json")) {
      payload = await response.json();
    }

    if (!response.ok) {
      const message = typeof payload?.error?.message === "string"
        ? payload.error.message
        : `The request failed with status ${response.status}.`;
      throw new Error(message);
    }

    return payload;
  }

  #inferLatestPosition(events) {
    return events.reduce((latest, event) => {
      const position = Number(event?.position);
      return Number.isSafeInteger(position) && position > latest
        ? position
        : latest;
    }, 0);
  }

  #render() {
    if (this.#elements === null) return;

    const historical = this.#engine === "hyperkernel" &&
      this.#viewPosition !== null;
    const mutationDisabled = historical || this.#pending !== null ||
      this.#loading || this.#error !== null;
    const engineName = ENGINES[this.#engine];

    this.dataset.engine = this.#engine;
    this.#elements.appMain.setAttribute(
      "aria-busy",
      String(this.#loading || this.#pending !== null),
    );

    for (const radio of this.querySelectorAll('input[name="engine"]')) {
      if (!(radio instanceof HTMLInputElement)) continue;
      radio.checked = radio.value === this.#engine;
      radio.disabled = this.#pending !== null || this.#loading;
    }

    this.#elements.statusBadge.textContent = historical
      ? `Event #${this.#viewPosition}`
      : "Live";
    this.#elements.statusBadge.classList.toggle(
      "status-badge--history",
      historical,
    );
    this.#elements.contextTitle.textContent = historical
      ? "Historical Hyperkernel snapshot"
      : `Live ${engineName} data`;
    this.#elements.contextDescription.textContent = historical
      ? `Viewing state after event ${this.#viewPosition}. Return to live data to make changes.`
      : this.#engine === "hyperkernel"
      ? "Mutations append an event and update the todo projection atomically."
      : "Mutations write directly to the todo table with prepared SQL statements.";
    this.#elements.returnLive.hidden = !historical;
    this.#elements.returnLive.disabled = this.#pending !== null ||
      this.#loading;

    this.#renderNotice();
    this.#elements.retry.disabled = this.#pending !== null || this.#loading;

    this.#elements.titleInput.disabled = mutationDisabled;
    this.#elements.addButton.disabled = mutationDisabled;
    this.#elements.addButton.textContent = this.#pending?.type === "create"
      ? "Adding…"
      : "Add todo";
    this.#elements.formHelp.hidden = historical;
    this.#elements.formHelp.textContent = `This writes to ${engineName} only.`;
    this.#elements.historicalLock.hidden = !historical;

    const total = this.#todos.length;
    const open = this.#todos.filter((todo) => !todo.completed).length;
    this.#elements.todoCount.textContent = `${open} open · ${total} total`;

    const initialLoading = this.#loading && !this.#hasLoaded;
    this.#elements.listLoading.hidden = !initialLoading;
    const empty = !initialLoading && this.#error === null && total === 0;
    this.#elements.emptyState.hidden = !empty;
    this.#elements.emptyTitle.textContent = historical
      ? "No todos at this point"
      : "No todos yet";
    this.#elements.emptyDescription.textContent = historical
      ? "The selected event position has no active todos."
      : "Add the first task to start this comparison.";

    this.#renderTodos(mutationDisabled);
    this.#renderEvents();
  }

  #renderNotice() {
    const showLoading = this.#loading && this.#hasLoaded;
    const showError = this.#error !== null;
    this.#elements.notice.hidden = !showLoading && !showError;
    this.#elements.notice.classList.toggle("notice--error", showError);
    this.#elements.notice.setAttribute("role", showError ? "alert" : "status");
    this.#elements.noticeSpinner.hidden = !showLoading || showError;
    this.#elements.retry.hidden = !showError;

    if (showError) {
      this.#elements.noticeText.textContent = this.#error;
    } else if (showLoading) {
      this.#elements.noticeText.textContent = this.#viewPosition === null
        ? "Refreshing live data."
        : `Loading event position ${this.#viewPosition}.`;
    }
  }

  #renderTodos(mutationDisabled) {
    const fragment = document.createDocumentFragment();

    this.#todos.forEach((todo, index) => {
      const id = String(todo.id ?? "");
      const title = String(todo.title ?? "Untitled todo");
      const completed = Boolean(todo.completed);
      const item = document.createElement("li");
      item.className = "todo-item";
      item.classList.toggle("todo-item--completed", completed);

      const label = document.createElement("label");
      label.className = "todo-label";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "completed";
      checkbox.id = `todo-completed-${index}`;
      checkbox.checked = completed;
      checkbox.disabled = mutationDisabled;
      checkbox.dataset.todoToggle = "";
      checkbox.dataset.todoId = id;
      checkbox.setAttribute(
        "aria-label",
        completed ? `Reopen ${title}` : `Complete ${title}`,
      );
      label.htmlFor = checkbox.id;

      const content = document.createElement("span");
      content.className = "todo-content";
      const titleElement = document.createElement("span");
      titleElement.className = "todo-title";
      titleElement.textContent = title;
      const metadata = document.createElement("span");
      metadata.className = "todo-metadata";
      metadata.textContent = this.#formatCreatedAt(todo.createdAt);
      content.append(titleElement, metadata);
      label.append(checkbox, content);

      const deleteButton = document.createElement("button");
      deleteButton.className = "delete-button";
      deleteButton.type = "button";
      deleteButton.dataset.deleteTodo = "";
      deleteButton.dataset.todoId = id;
      deleteButton.disabled = mutationDisabled;
      deleteButton.setAttribute("aria-label", `Delete ${title}`);
      deleteButton.textContent = this.#pending?.type === "delete" &&
          this.#pending.id === id
        ? "Deleting…"
        : "Delete";

      item.append(label, deleteButton);
      fragment.append(item);
    });

    this.#elements.todoList.replaceChildren(fragment);
    this.#elements.todoList.hidden = this.#todos.length === 0;
  }

  #renderEvents() {
    const visible = this.#engine === "hyperkernel";
    this.#elements.eventPanel.hidden = !visible;
    if (!visible) return;

    const count = this.#events.length;
    const firstPosition = this.#events[0]?.position;
    const lastPosition = this.#events.at(-1)?.position;
    this.#elements.eventCount.textContent = count === 0
      ? "0 events recorded"
      : this.#hasEarlierEvents || this.#hasLaterEvents
      ? `Events #${firstPosition}–#${lastPosition} of ${this.#latestPosition}`
      : count === 1
      ? "1 event recorded"
      : `${count} events recorded`;
    this.#elements.headPosition.textContent = `#${this.#latestPosition}`;
    this.#elements.positionInput.max = String(this.#latestPosition);
    this.#elements.positionInput.value = String(
      this.#viewPosition ?? this.#latestPosition,
    );
    this.#elements.positionInput.disabled = this.#latestPosition === 0 ||
      (this.#loading && this.#historyTimer === null) ||
      this.#pending !== null;
    this.#elements.positionMaximum.textContent = String(this.#latestPosition);
    this.#elements.positionOutput.textContent = this.#viewPosition === null
      ? `Live · #${this.#latestPosition}`
      : `Event #${this.#viewPosition}`;
    this.#elements.eventEmpty.hidden = count !== 0 ||
      (this.#loading && !this.#hasLoaded) || this.#error !== null;
    this.#elements.eventPager.hidden = count === 0 ||
      (!this.#hasEarlierEvents && !this.#hasLaterEvents);
    this.#elements.eventsOlder.disabled = this.#loading ||
      this.#pending !== null || !this.#hasEarlierEvents;
    this.#elements.eventsNewer.disabled = this.#loading ||
      this.#pending !== null || !this.#hasLaterEvents;

    const fragment = document.createDocumentFragment();
    for (const event of this.#events) {
      const position = Number(event?.position);
      if (!Number.isSafeInteger(position) || position < 0) continue;

      const item = document.createElement("li");
      const button = document.createElement("button");
      button.className = "event-button";
      button.type = "button";
      button.dataset.eventPosition = String(position);
      const selected = this.#viewPosition === position;
      button.classList.toggle("event-button--selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-label", `View state after event ${position}`);
      button.disabled = this.#loading || this.#pending !== null;

      const eventHeading = document.createElement("span");
      eventHeading.className = "event-heading";
      const positionElement = document.createElement("span");
      positionElement.className = "event-position";
      positionElement.textContent = `#${position}`;
      const typeElement = document.createElement("span");
      typeElement.className = "event-type";
      typeElement.textContent = String(event?.type ?? "UnknownEvent");
      eventHeading.append(positionElement, typeElement);

      const dataElement = document.createElement("code");
      dataElement.className = "event-data";
      dataElement.textContent = this.#formatEventData(event?.data);
      button.append(eventHeading, dataElement);
      item.append(button);
      fragment.append(item);
    }

    this.#elements.eventList.replaceChildren(fragment);
    this.#elements.eventList.hidden = count === 0;
  }

  #focusTodoControl(id, selector) {
    const control = [...this.querySelectorAll(selector)].find((candidate) =>
      candidate instanceof HTMLElement && candidate.dataset.todoId === id
    );
    if (control instanceof HTMLElement && !control.matches(":disabled")) {
      control.focus();
    }
  }

  #focusEngine(engine) {
    if (!this.isConnected) return;
    const radio = [...this.querySelectorAll('input[name="engine"]')].find(
      (candidate) =>
        candidate instanceof HTMLInputElement && candidate.value === engine,
    );
    if (radio instanceof HTMLInputElement && !radio.disabled) radio.focus();
  }

  #focusHistoryPosition() {
    if (
      this.isConnected && !this.#elements.positionInput.disabled &&
      !this.#elements.positionInput.hidden
    ) {
      this.#elements.positionInput.focus();
    }
  }

  #focusEvent(position) {
    if (!this.isConnected) return false;
    const button = [...this.querySelectorAll("[data-event-position]")].find(
      (candidate) =>
        candidate instanceof HTMLElement &&
        Number(candidate.dataset.eventPosition) === position,
    );
    if (button instanceof HTMLElement && !button.matches(":disabled")) {
      button.focus();
      return true;
    }
    return false;
  }

  #focusEventPager(direction) {
    if (!this.isConnected) return;
    const preferred = direction === "older"
      ? this.#elements.eventsOlder
      : this.#elements.eventsNewer;
    const fallback = direction === "older"
      ? this.#elements.eventsNewer
      : this.#elements.eventsOlder;
    const target = preferred.matches(":disabled") ? fallback : preferred;
    if (!target.matches(":disabled") && !target.hidden) target.focus();
  }

  #focusAfterNavigation() {
    if (!this.isConnected) return;
    if (this.#error !== null) {
      this.#elements.retry.focus();
      return;
    }

    if (this.#viewPosition !== null) {
      if (!this.#focusEvent(this.#viewPosition)) this.#focusHistoryPosition();
      return;
    }

    this.#elements.titleInput.focus();
  }

  #formatCreatedAt(value) {
    if (
      !((typeof value === "string" && value.length > 0) ||
        typeof value === "number")
    ) {
      return "Created recently";
    }
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return "Created recently";
    return `Created ${
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
    }`;
  }

  #formatEventData(value) {
    if (typeof value === "string") {
      try {
        return JSON.stringify(JSON.parse(value));
      } catch {
        return value;
      }
    }

    try {
      return JSON.stringify(value ?? {});
    } catch {
      return "Event data is not displayable.";
    }
  }

  #announce(message) {
    this.#elements.announcer.textContent = "";
    requestAnimationFrame(() => {
      this.#elements.announcer.textContent = message;
    });
  }
}

if (!customElements.get("todo-comparison")) {
  customElements.define("todo-comparison", TodoComparison);
}
