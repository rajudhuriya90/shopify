/* ═══════════════════════════════════════════════════════════════════
   app.js — Cart Rewards Feature
   Vanilla JavaScript only. No frameworks, no libraries.

   ARCHITECTURE: Observer Pattern (Pub-Sub)
   ─────────────────────────────────────────
   All modules communicate through EventBus events.
   No module holds a direct reference to another module.
   This means modules are independently replaceable and testable.

   MODULE LOAD ORDER (dependency chain):
     1. Config        — thresholds (no deps)
     2. EventBus      — event system (no deps)
     3. CartStore     — cart state   (needs EventBus)
     4. RewardEngine  — reward logic (needs Config, CartStore, EventBus)
     5. CartUI        — DOM updates  (needs CartStore, Config, EventBus)
     6. SettingsPanel — admin UI     (needs Config, CartStore)
     7. StateDebug    — live viewer  (needs all above)
     8. Bootstrap     — wires everything up and seeds demo data
═══════════════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════════════
   MODULE 1: Config
   ─────────────────────────────────────────────────────────────────
   PURPOSE: Single source of truth for all reward threshold values.
            Admin settings update Config; the rest of the app reacts.

   WHY THIS WAY: If you hard-code 3000 in 4 different places and the
   threshold needs to change, you'd have to find all 4 places. With
   Config as the single source, you change one value.

   HOW TO EXTEND: In a real Shopify store, replace the initial values
   with a fetch() call to Shopify's metafields or a theme setting.
═══════════════════════════════════════════════════════════════════ */
const Config = {
  shipping: 3000,   // ₹ — free shipping threshold
  gift: 5000,       // ₹ — mystery gift threshold

  /**
   * update(key, value)
   * ──────────────────
   * Safely updates a threshold value after validation.
   * After a successful update it fires 'config:change' so all
   * modules that depend on thresholds (RewardEngine) re-evaluate.
   *
   * @param {string} key   - 'shipping' or 'gift'
   * @param {number} value - new threshold in ₹
   * @returns {boolean}    - true if update succeeded, false if invalid
   */
  update(key, value) {
    if (typeof value !== 'number' || isNaN(value) || value < 0) {
      console.error(`[Config] Invalid value for "${key}": ${value}`);
      return false;
    }
    this[key] = value;
    EventBus.emit('config:change', { key, value });
    return true;
  }
};


/* ═══════════════════════════════════════════════════════════════════
   MODULE 2: EventBus
   ─────────────────────────────────────────────────────────────────
   PURPOSE: Implements the Publish-Subscribe (Observer) design pattern.
            Acts as a central message broker between modules.

   HOW IT WORKS:
   • on(event, callback)  → Register a listener. When 'event' is emitted,
                            'callback' will be called with the event data.
   • emit(event, data)    → Notify all listeners registered for 'event'.

   WHY THIS MATTERS:
   • CartStore doesn't need to know CartUI exists.
   • CartUI doesn't need to know CartStore exists.
   • They only know about EventBus and event names (strings).
   • This makes it trivially easy to add new subscribers later
     (e.g. a "cart saved" analytics tracker) without touching existing code.

   EVENTS USED IN THIS APP:
   • 'cart:change'    — emitted by CartStore on any mutation
   • 'config:change'  — emitted by Config when a threshold updates
   • 'reward:update'  — emitted by RewardEngine with the new reward state
═══════════════════════════════════════════════════════════════════ */
const EventBus = {
  _listeners: {},   // { eventName: [callback, callback, ...] }

  /**
   * on(event, callback)
   * ────────────────────
   * Registers a callback to be called whenever 'event' is emitted.
   * Multiple callbacks can be registered for the same event.
   *
   * Uses nullish assignment (??=) to lazily initialise the array
   * only when the first listener for that event is added.
   *
   * @param {string}   event    - Event name, e.g. 'cart:change'
   * @param {Function} callback - Function to call when event fires
   */
  on(event, callback) {
    if (!this._listeners[event]) {
      this._listeners[event] = [];
    }
    this._listeners[event].push(callback);
  },

  /**
   * emit(event, data)
   * ──────────────────
   * Calls all registered callbacks for 'event', passing 'data' to each.
   * Wrapped in try/catch per callback so one failing listener doesn't
   * break the others — important for resilience in production.
   *
   * @param {string} event - Event name to broadcast
   * @param {*}      data  - Payload passed to each callback
   */
  emit(event, data) {
    const listeners = this._listeners[event] || [];
    listeners.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error(`[EventBus] Error in handler for "${event}":`, error);
      }
    });
  }
};


/* ═══════════════════════════════════════════════════════════════════
   MODULE 3: CartStore
   ─────────────────────────────────────────────────────────────────
   PURPOSE: Manages all cart state. The ONLY place cart data is mutated.
            Think of it as a mini Redux store — centralised, predictable.

   STATE SHAPE:
     items: Array<{
       id:      string,   // unique product identifier
       name:    string,   // display name
       variant: string,   // e.g. "Black", "White / 42"
       emoji:   string,   // thumbnail substitute for demo
       price:   number,   // price per unit in ₹
       qty:     number    // quantity in cart
     }>

   PATTERN: Every public method that changes state calls _notify()
   at the end. This ensures the rest of the app always reacts to
   every state change, no exceptions.
═══════════════════════════════════════════════════════════════════ */

/** Demo product catalogue — in Shopify this comes from the store */
const SAMPLE_PRODUCTS = [
  {
    id: 'backpack',
    name: 'Classic Backpack',
    variant: 'Black',
    image: '/images/products/backpack.webp',
    price: 1799
  },
  {
    id: 'sneakers',
    name: 'Minimal Sneakers',
    variant: 'White / 42',
    image: '/images/products/sneakers.webp',
    price: 2199
  },
  {
    id: 'watch',
    name: 'Minimalist Watch',
    variant: 'Silver',
    image: '/images/products/silver_watch.webp',
    price: 3499
  },
  {
    id: 'cap',
    name: 'Canvas Cap',
    variant: 'Olive',
    image: '/images/products/cap.webp',
    price: 599
  },
  {
    id: 'sunglasses',
    name: ' Black Sunglasses ',
    variant: 'black',
    image: '/images/products/sunglasses.webp',
    price: 499
  },

];

const CartStore = {
  items: [],   // Current cart contents (mutated by the methods below)

  /**
   * addItem(product)
   * ─────────────────
   * Adds a product to the cart. If the product already exists
   * (matched by id), increments its qty. Otherwise creates a new entry.
   *
   * Uses Array.find() to check for an existing item — O(n) but fine
   * for cart sizes (typically < 20 items).
   *
   * Wrapped in try/catch to handle unexpected errors gracefully.
   *
   * @param {Object} product - Product object from SAMPLE_PRODUCTS
   */
  addItem(product) {
    try {
      const existing = this.items.find(item => item.id === product.id);
      if (existing) {
        existing.qty++;
      } else {
        this.items.push({ ...product, qty: 1 });
        // Spread operator (...product) copies all product properties
        // into a new object, then we add qty:1. This avoids mutating
        // the original product from SAMPLE_PRODUCTS.
      }
      this._notify();
    } catch (error) {
      console.error('[CartStore] addItem failed:', error);
    }
  },

  /**
   * removeItem(id)
   * ──────────────
   * Removes the item with the given id entirely from the cart,
   * regardless of its current quantity.
   *
   * Array.filter() creates a NEW array without the removed item.
   * This is the immutable update pattern — important for predictability.
   *
   * @param {string} id - Product id to remove
   */
  removeItem(id) {
    this.items = this.items.filter(item => item.id !== id);
    this._notify();
  },

  /**
   * updateQty(id, delta)
   * ─────────────────────
   * Changes the quantity of an item by delta (+1 or -1).
   * If qty drops to 0 or below, the item is automatically removed.
   *
   * Math.max(0, qty + delta) prevents negative quantities.
   *
   * @param {string} id    - Product id to update
   * @param {number} delta - Change in quantity, typically +1 or -1
   */
  updateQty(id, delta) {
    const item = this.items.find(i => i.id === id);
    if (!item) return;   // guard: item not found, do nothing

    item.qty = Math.max(0, item.qty + delta);

    // Auto-remove if qty reaches 0
    if (item.qty === 0) {
      this.items = this.items.filter(i => i.id !== id);
    }

    this._notify();
  },

  /**
   * getTotal()
   * ──────────
   * Calculates the cart subtotal by summing price × qty for all items.
   *
   * Array.reduce() is the idiomatic way to sum an array.
   * Starting accumulator is 0 (the initial value after the comma).
   *
   * @returns {number} Cart total in ₹
   */
  getTotal() {
    return this.items.reduce((sum, item) => sum + (item.price * item.qty), 0);
  },

  /**
   * getCount()
   * ──────────
   * Returns total number of individual items across all lines.
   * Used for the cart badge (e.g. "2 items" even if they're different products).
   *
   * @returns {number} Total item quantity
   */
  getCount() {
    return this.items.reduce((sum, item) => sum + item.qty, 0);
  },

  /**
   * _notify()  [private — prefix _ signals "internal use only"]
   * ────────────
   * Broadcasts the 'cart:change' event to all EventBus subscribers.
   * Passes `this` (the store itself) as payload so subscribers can
   * read current state without importing CartStore directly.
   *
   * Called at the end of EVERY mutation method — addItem, removeItem,
   * updateQty. Never skipped, ensures UI is always in sync with state.
   */
  _notify() {
    EventBus.emit('cart:change', this);
  }
};


/* ═══════════════════════════════════════════════════════════════════
   MODULE 4: RewardEngine
   ─────────────────────────────────────────────────────────────────
   PURPOSE: Contains ALL reward business logic. Determines which
            rewards are unlocked and computes UI display values.

   KEY DESIGN DECISION — Pure Logic, No DOM Access:
   This module NEVER touches document.getElementById or innerHTML.
   It only takes a number (total) and returns a plain object.
   This makes it:
   • Easy to unit test (just call compute(3500) and check the result)
   • Reusable (same logic could drive a server-side API)
   • Decoupled (UI changes don't affect logic; logic changes don't
     break UI as long as the returned object shape stays the same)

   SUBSCRIPTIONS:
   • 'cart:change'   → re-runs compute() when items change
   • 'config:change' → re-runs compute() when admin updates thresholds
   Both trigger emission of 'reward:update' with the new state.
═══════════════════════════════════════════════════════════════════ */
const RewardEngine = {

  /**
   * compute(total)
   * ───────────────
   * Core calculation function. Given a cart total, returns a complete
   * reward state object for the UI to render.
   *
   * PROGRESS BAR LOGIC:
   * The bar spans from 0 to the gift threshold (₹5000 by default).
   * There are two milestone markers:
   *   • Shipping milestone at (shipping/gift)% along the track
   *   • Gift milestone at 100% (the end of the track)
   *
   * @param   {number} total - Current cart total in ₹
   * @returns {Object}       - Complete reward state (see shape below)
   */
  compute(total) {
    const ship = Config.shipping;   // e.g. 3000
    const gift = Config.gift;       // e.g. 5000

    // ── Reward flags ─────────────────────────────────────────────
    const hasShipping = total > ship;   // true once total passes ₹3000
    const hasGift     = total > gift;   // true once total passes ₹5000

    // ── Milestone positions on the progress bar (as % of gift) ───
    const shipMilestonePct = (ship / gift) * 100;   // e.g. 60% when ship=3000, gift=5000
    const giftMilestonePct = 100;                   // always at the end

    // ── Progress fill percentage & colour class ───────────────────
    // The fill grows from 0 to 100% as total grows from 0 to gift.
    // Colour class changes as milestones are crossed.
    let progressPct, progressClass;

    if (total <= 0) {
      progressPct   = 0;
      progressClass = 'none';
    } else if (total <= ship) {
      progressPct   = (total / gift) * 100;
      progressClass = 'none';         // grey — no reward yet
    } else if (total <= gift) {
      progressPct   = (total / gift) * 100;
      progressClass = 'shipping';     // green — shipping unlocked
    } else {
      progressPct   = 100;
      progressClass = 'gift';         // purple — both unlocked
    }

    // ── Helper labels for progress bar
    let progressLabel, progressGoal;

    if (!hasShipping) {
      const remaining = ship - total;
      progressLabel = `₹${remaining.toLocaleString('en-IN')} more to unlock free shipping!`;
      progressGoal  = `₹${ship.toLocaleString('en-IN')}`;
    } else if (!hasGift) {
      const remaining = gift - total;
      progressLabel = `₹${remaining.toLocaleString('en-IN')} more to unlock a mystery gift!`;
      progressGoal  = `₹${gift.toLocaleString('en-IN')}`;
    } else {
      progressLabel = `You've unlocked all rewards! 🎉`;
      progressGoal  = '';
    }

    // ── Mystery gift bottom banner ────────────────────────────────
    const mysteryPct = Math.min((total / gift) * 100, 100);
    const mysteryLabel = !hasGift
      ? `Add items worth ₹${(gift - total).toLocaleString('en-IN')} more to unlock a mystery gift!`
      : `Mystery gift unlocked! 🎁`;

    // ── Return the complete state object ──────────────────────────
    return {
      hasShipping,          // boolean — used to show/hide banners
      hasGift,              // boolean — used to show/hide banners
      progressPct,          // number  — progress bar fill width %
      progressClass,        // string  — CSS class for bar colour
      shipMilestonePct,     // number  — where to place shipping dot
      giftMilestonePct,     // number  — where to place gift dot
      progressLabel,        // string  — text under progress bar
      progressGoal,         // string  — right-side goal label
      mysteryPct,           // number  — bottom banner progress %
      mysteryLabel,         // string  — bottom banner text
      total                 // number  — cart total (passed through)
    };
  },

  /**
   * init()
   * ───────
   * Wires up EventBus subscriptions so RewardEngine reacts to
   * both cart changes and config changes.
   *
   * Both subscriptions call the same recompute() closure,
   * which reads the current CartStore total and runs compute().
   */
  init() {
    const recompute = () => {
      const total = CartStore.getTotal();
      const rewardState = this.compute(total);
      EventBus.emit('reward:update', rewardState);
    };

    EventBus.on('cart:change',   recompute);   // fires when items change
    EventBus.on('config:change', recompute);   // fires when admin saves settings
  }
};


/* ═══════════════════════════════════════════════════════════════════
   MODULE 5: CartUI
   ─────────────────────────────────────────────────────────────────
   PURPOSE: Owns ALL DOM manipulation. The only module that calls
            document.getElementById, classList.toggle, textContent, etc.

   KEY DESIGN DECISION — No Business Logic in the UI:
   CartUI never calculates "should shipping be shown?" — that answer
   comes from RewardEngine via the 'reward:update' event. CartUI only
   translates the state object into DOM changes.

   ANIMATION APPROACH:
   Animations are CSS-only (transition property). JS just toggles
   a CSS class. This is more performant than JS animations (no layout
   thrashing) and easier to maintain.
═══════════════════════════════════════════════════════════════════ */
const CartUI = {

  /**
   * init()
   * ───────
   * Registers all EventBus subscriptions. Called once during bootstrap.
   */
  init() {
    // React to reward state changes (banner visibility, progress bar)
    EventBus.on('reward:update', state => {
      this.renderBanners(state);
      this.renderProgress(state);
      this.renderMysteryBanner(state);
    });

    // React to cart data changes (item list, subtotal, badge)
    EventBus.on('cart:change', () => {
      this.renderItems();
      this.renderSubtotal();
      this.renderBadge();
    });
  },

  /**
   * renderBanners({ hasShipping, hasGift })
   * ─────────────────────────────────────────
   * Shows or hides the top reward banners by toggling the
   * CSS class 'visible'. The CSS transition on max-height
   * handles the smooth open/close animation automatically.
   *
   * classList.toggle(class, condition) adds the class when
   * condition is true, removes it when condition is false.
   *
   * @param {Object} state - Reward state from RewardEngine.compute()
   */
  renderBanners({ hasShipping, hasGift }) {
    document.getElementById('banner-shipping')
      .classList.toggle('visible', hasShipping);

    document.getElementById('banner-gift')
      .classList.toggle('visible', hasGift);
  },

  /**
   * renderProgress({ progressPct, progressClass, shipMilestonePct,
   *                   progressLabel, progressGoal })
   * ──────────────────────────────────────────────────────────────
   * Updates the progress bar:
   * • Fill width (triggers CSS width transition)
   * • Fill colour class (shipping = green, gift = purple)
   * • Label text (e.g. "₹1,002 more to unlock a mystery gift!")
   * • Milestone dot positions and colours
   *
   * @param {Object} state - Reward state from RewardEngine.compute()
   */
  renderProgress({ progressPct, progressClass, shipMilestonePct, progressLabel, progressGoal }) {
    const fill   = document.getElementById('progress-fill');
    const label  = document.getElementById('progress-label');
    const goal   = document.getElementById('progress-goal');
    const msShip = document.getElementById('ms-ship');
    const msGift = document.getElementById('ms-gift');

    // Update fill bar
    fill.style.width = `${Math.min(progressPct, 100)}%`;
    fill.className   = `progress-fill ${progressClass}`;

    // Update labels
    label.textContent = progressLabel;
    goal.textContent  = progressGoal;

    // Position and colour milestone dots
    msShip.style.left = `${shipMilestonePct}%`;
    msGift.style.left = `100%`;

    const total = CartStore.getTotal();
    msShip.className = `milestone ${total > Config.shipping ? 'reached' : 'unreached'}`;
    msGift.className = `milestone ${total > Config.gift     ? 'reached gift-ms' : 'unreached'}`;
  },

  /**
   * renderItems()
   * ──────────────
   * Re-renders the full cart item list from CartStore.items.
   * Clears the container, then builds each row programmatically.
   *
   * WHY NOT innerHTML WITH A TEMPLATE STRING?
   * We use document.createElement() for the dynamic data rows
   * to avoid XSS. If a product name contained HTML like
   * <script>alert(1)</script>, using innerHTML directly would
   * execute it. textContent and _esc() prevent this.
   *
   * The inner row (qty buttons) uses innerHTML safely because
   * the only dynamic values are item.id which comes from our
   * own SAMPLE_PRODUCTS array, not user input.
   */
  renderItems() {
    const container = document.getElementById('cart-items-container');
    container.innerHTML = '';   // clear previous render

    // Empty cart state
    if (CartStore.items.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:32px 0;color:var(--muted);font-size:.88rem">
          Your cart is empty. Click "+ Add Item" to see rewards!
        </div>`;
      return;
    }

    // Render each cart item as a grid row
    CartStore.items.forEach(item => {
      const row = document.createElement('div');
      row.className  = 'cart-item';
      row.dataset.id = item.id;

      // ── Product info column ──────────────────────────────────
      const info = document.createElement('div');
      info.className = 'item-info';
      info.innerHTML = `
        <div class="item-thumb">
  <img src="${item.image}" alt="${this._esc(item.name)}" />
  </div>
        <div>
          <div class="item-name">${this._esc(item.name)}</div>
          <div class="item-variant">${this._esc(item.variant)}</div>
          <button class="item-remove" onclick="CartStore.removeItem('${item.id}')">Remove</button>
        </div>`;

      // ── Price column ────────────────────────────────────────
      const priceEl = document.createElement('div');
      priceEl.className   = 'item-price';
      priceEl.textContent = `₹${item.price.toLocaleString('en-IN')}`;

      // ── Quantity stepper column ─────────────────────────────
      const qtyEl = document.createElement('div');
      qtyEl.className = 'qty-stepper';
      qtyEl.innerHTML = `
        <button class="qty-btn" onclick="CartStore.updateQty('${item.id}', -1)">−</button>
        <div class="qty-val">${item.qty}</div>
        <button class="qty-btn" onclick="CartStore.updateQty('${item.id}', +1)">+</button>`;

      // ── Total column ────────────────────────────────────────
      const totalEl = document.createElement('div');
      totalEl.className   = 'item-total';
      totalEl.textContent = `₹${(item.price * item.qty).toLocaleString('en-IN')}`;

      row.append(info, priceEl, qtyEl, totalEl);
      container.appendChild(row);
    });
  },

  /**
   * renderSubtotal()
   * ─────────────────
   * Updates the subtotal number and toggles the inline
   * free shipping confirmation note below it.
   */
  renderSubtotal() {
    const total = CartStore.getTotal();
    document.getElementById('subtotal-amount').textContent =
      `₹${total.toLocaleString('en-IN')}`;

    document.getElementById('free-ship-note')
      .classList.toggle('visible', total > Config.shipping);
  },

  /**
   * renderBadge()
   * ──────────────
   * Updates the small count badge on the cart icon.
   * Hidden when cart is empty.
   */
  renderBadge() {
    const badge = document.getElementById('cart-badge');
    const count = CartStore.getCount();
    badge.textContent  = count;
    badge.style.display = count > 0 ? 'inline' : 'none';
  },

  /**
   * renderMysteryBanner({ hasGift, mysteryPct, mysteryLabel })
   * ─────────────────────────────────────────────────────────────
   * Controls the bottom purple mystery gift banner:
   * • Hidden once the gift is unlocked (it's no longer needed)
   * • Progress fill shows how close the user is to ₹5000
   *
   * @param {Object} state - Reward state from RewardEngine.compute()
   */
  renderMysteryBanner({ hasGift, mysteryPct, mysteryLabel }) {
    const banner = document.getElementById('mystery-banner');
    const fill   = document.getElementById('mystery-fill');
    const text   = document.getElementById('mystery-text-main');
    const goal   = document.getElementById('mystery-goal-label');

    banner.style.display = hasGift ? 'none' : 'flex';
    fill.style.width     = `${mysteryPct}%`;
    text.textContent     = mysteryLabel;
    goal.textContent     = `₹${Config.gift.toLocaleString('en-IN')}`;
  },

  /**
   * addRandomItem()
   * ────────────────
   * Picks a random product from SAMPLE_PRODUCTS and adds it to cart.
   * Called by the "+ Add Item" demo button.
   * Shows a toast confirmation.
   */
  addRandomItem() {
    const availableProducts = SAMPLE_PRODUCTS.filter(
      product => !CartStore.items.some(item => item.id === product.id)
    );
  
    if (availableProducts.length === 0) {
      showToast('All products already added');
      return;
    }
  
    const pick =
      availableProducts[Math.floor(Math.random() * availableProducts.length)];
  
    CartStore.addItem(pick);
    showToast(`Added ${pick.name} to cart`);
  },

  /**
   * _esc(str)  [private utility]
   * ──────────
   * Minimal XSS escape for strings inserted via innerHTML.
   * Converts the 5 dangerous HTML characters to their entity equivalents.
   * Prevents malicious product names from injecting HTML/scripts.
   *
   * @param   {string} str - Raw string to escape
   * @returns {string}     - Safe string for innerHTML use
   */
  _esc(str) {
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }
};


/* ═══════════════════════════════════════════════════════════════════
   MODULE 6: SettingsPanel
   ─────────────────────────────────────────────────────────────────
   PURPOSE: Admin-facing settings form. Reads, validates, and applies
            new threshold values to Config in real time.

   VALIDATION RULES:
   1. Both values must be positive integers
   2. Gift threshold must be strictly greater than shipping threshold
      (otherwise the reward order makes no sense)

   REAL-TIME UPDATE FLOW:
   save() → Config.update() → EventBus fires 'config:change'
   → RewardEngine recomputes → CartUI re-renders
   All happens in < 1ms with no page reload.
═══════════════════════════════════════════════════════════════════ */
const SettingsPanel = {

  /**
   * save()
   * ───────
   * Reads current input values, validates them, and if valid:
   * 1. Updates Config (triggers the reactive update chain)
   * 2. Calls CartStore._notify() to force a full re-evaluation
   * 3. Shows success toast and button feedback
   *
   * If validation fails, highlights the offending input in red
   * and shows an error toast.
   */
  save() {
    const shipInput = document.getElementById('input-ship');
    const giftInput = document.getElementById('input-gift');
    const btn       = document.getElementById('btn-save');

    // Parse as integers (ignores decimal input, keeps it clean)
    const ship = parseInt(shipInput.value, 10);
    const gift = parseInt(giftInput.value, 10);

    // ── Validation ────────────────────────────────────────────
    // Reset previous error states first
    shipInput.style.borderColor = '';
    giftInput.style.borderColor = '';

    if (isNaN(ship) || isNaN(gift) || ship <= 0 || gift <= 0) {
      showToast('⚠️ Please enter valid positive thresholds.', 'error');
      if (isNaN(ship) || ship <= 0) shipInput.style.borderColor = 'var(--danger)';
      if (isNaN(gift) || gift <= 0) giftInput.style.borderColor = 'var(--danger)';
      return;   // stop here — don't save invalid values
    }

    if (gift <= ship) {
      showToast('⚠️ Gift threshold must be greater than shipping threshold.', 'error');
      giftInput.style.borderColor = 'var(--danger)';
      return;
    }

    // ── Apply updates ─────────────────────────────────────────
    // Config.update() internally fires 'config:change' via EventBus
    Config.update('shipping', ship);
    Config.update('gift',     gift);

    // Force CartStore to re-notify so CartUI re-evaluates
    // against the new thresholds immediately
    CartStore._notify();

    // ── Sync inputs to reflect saved values ───────────────────
    this.syncInputs();

    // ── Visual success feedback ───────────────────────────────
    btn.innerHTML = '✓ Saved!';
    btn.classList.add('saved');
    showToast('✔ Settings saved. Rewards updated in real time.');

    setTimeout(() => {
      btn.innerHTML = '<span>⚙</span> Save Settings';
      btn.classList.remove('saved');
    }, 2000);
  },

  /**
   * syncInputs()
   * ─────────────
   * Keeps the input fields in sync with current Config values.
   * Called on app init so inputs show the default thresholds,
   * and after a successful save to confirm the stored values.
   */
  syncInputs() {
    document.getElementById('input-ship').value = Config.shipping;
    document.getElementById('input-gift').value = Config.gift;
  }
};




/* ═══════════════════════════════════════════════════════════════════
   UTILITY: showToast(message, type)
   ─────────────────────────────────────────────────────────────────
   PURPOSE: Displays a brief notification at the bottom-right corner.
            Auto-dismisses after 3 seconds.

   HOW IT WORKS:
   • Adds the .show CSS class → transition animates it in
   • Sets a 3-second timeout to remove .show → animates it out
   • clearTimeout prevents multiple toasts from conflicting

   @param {string} message        - Text to display
   @param {string} [type='success'] - 'success' (dark) or 'error' (red)
═══════════════════════════════════════════════════════════════════ */
function showToast(message, type = 'success') {
  const el = document.getElementById('toast');
  if (!el) return;

  el.textContent = message;
  el.style.background = type === 'error' ? 'var(--danger)' : 'var(--text)';

  // Trigger animation
  el.classList.add('show');

  // Clear any existing timer (prevents a queued hide from closing the new toast early)
  clearTimeout(el._dismissTimer);
  el._dismissTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 3000);
}


/* ═══════════════════════════════════════════════════════════════════
   BOOTSTRAP — Application Entry Point
   ─────────────────────────────────────────────────────────────────
   PURPOSE: Initialises all modules in the correct dependency order
            and seeds the cart with demo data.

   Uses an IIFE (Immediately Invoked Function Expression) to avoid
   polluting the global scope with the init variable.

   ORDER MATTERS:
   1. RewardEngine.init() must come before CartStore mutations
      so it's already listening when the first item is added.
   2. CartUI.init() same — must listen before data loads.
   3. StateDebug.init() same.
   4. SettingsPanel.syncInputs() just reads Config, safe at any point.
   5. CartStore.addItem() last — triggers the full event chain,
      and by now all listeners are registered.
═══════════════════════════════════════════════════════════════════ */
(function bootstrap() {
  // Step 1: Register all event subscribers
  RewardEngine.init();
  CartUI.init();
  StateDebug.init();

  // Step 2: Populate settings inputs with current Config values
  SettingsPanel.syncInputs();

  // Step 3: Seed demo cart — these fire 'cart:change' which
  //         triggers the full RewardEngine → CartUI render pipeline
  CartStore.addItem(SAMPLE_PRODUCTS[0]);   // Classic Backpack  ₹1,799
  CartStore.addItem(SAMPLE_PRODUCTS[1]);   // Minimal Sneakers  ₹2,199
  // Initial total: ₹3,998 → just above the ₹3,000 shipping threshold

  console.log('[App] Cart Rewards Feature initialised. Modules: Config, EventBus, CartStore, RewardEngine, CartUI, SettingsPanel, StateDebug');
})();
