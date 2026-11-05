-- RUBE-STOCK-POS v3.1 Initial Production Schema (26 Tables)
-- Enforces Fixed-Point Scaled Integer Types, Foreign Keys, Check Constraints & Immutable Audit Triggers

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- 1. System Configuration, Internal Cluster Keyring, Audit Logs & Schema Migrations
CREATE TABLE store_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    is_protected INTEGER NOT NULL DEFAULT 0 CHECK (is_protected IN (0, 1)),
    hmac_signature_hex TEXT,
    updated_by TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE security_keyring (
    key_id TEXT PRIMARY KEY,
    key_purpose TEXT NOT NULL CHECK (key_purpose IN ('DPAPI_MACHINE_KEK', 'RECOVERY_ARGON2_KEK', 'INTERNAL_ROOT_CA', 'LAN_CLUSTER_PSK')),
    kdf_algorithm TEXT NOT NULL DEFAULT 'ARGON2ID',
    kdf_salt_hex TEXT NOT NULL,
    kdf_iterations INTEGER NOT NULL,
    kdf_memory_kb INTEGER NOT NULL,
    wrapped_dek_cipher_hex TEXT NOT NULL,
    iv_hex TEXT NOT NULL,
    auth_tag_hex TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE security_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    actor_user_id TEXT,
    terminal_id TEXT,
    target_key TEXT,
    old_value_redacted TEXT,
    new_value_redacted TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    execution_ms INTEGER NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 2. Outlets, Terminals (with Epoch Fencing), Users & Cashier Shifts
CREATE TABLE outlets (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    tax_id TEXT,
    branch_code TEXT NOT NULL DEFAULT '00000',
    rd_pos_reg_no TEXT,
    is_warehouse INTEGER NOT NULL DEFAULT 0 CHECK (is_warehouse IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE pos_terminals (
    id TEXT PRIMARY KEY,
    outlet_id TEXT NOT NULL REFERENCES outlets(id),
    terminal_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('LEADER', 'FOLLOWER_POS', 'FOLLOWER_KDS')),
    cluster_epoch INTEGER NOT NULL DEFAULT 1 CHECK (cluster_epoch >= 1),
    client_cert_fingerprint TEXT UNIQUE,
    ip_address TEXT,
    last_heartbeat_at TEXT,
    last_replicated_tx_seq INTEGER NOT NULL DEFAULT 0,
    last_acked_kds_seq INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('OWNER', 'MANAGER', 'CASHIER', 'WAREHOUSE', 'KITCHEN')),
    pin_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE pos_shifts (
    id TEXT PRIMARY KEY,
    shift_number TEXT NOT NULL UNIQUE,
    outlet_id TEXT NOT NULL REFERENCES outlets(id),
    terminal_id TEXT NOT NULL REFERENCES pos_terminals(id),
    opened_by TEXT NOT NULL REFERENCES users(id),
    closed_by TEXT REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
    opening_cash_satang INTEGER NOT NULL DEFAULT 0 CHECK (opening_cash_satang >= 0),
    expected_cash_satang INTEGER NOT NULL DEFAULT 0,
    counted_cash_satang INTEGER,
    cash_variance_satang INTEGER,
    notes TEXT,
    opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    closed_at TEXT
);

CREATE TABLE cash_drawer_movements (
    id TEXT PRIMARY KEY,
    shift_id TEXT NOT NULL REFERENCES pos_shifts(id) ON DELETE RESTRICT,
    movement_type TEXT NOT NULL CHECK (movement_type IN ('OPENING_FLOAT', 'PAID_IN', 'PAID_OUT', 'CASH_DROP')),
    amount_satang INTEGER NOT NULL CHECK (amount_satang > 0),
    reason TEXT NOT NULL,
    performed_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 3. Catalog, Variants, Multi-Level BOM (with Component Roles) & Stock-Aware Modifiers
CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_color TEXT NOT NULL DEFAULT '#3B82F6',
    kitchen_station TEXT DEFAULT 'MAIN',
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category_id TEXT REFERENCES categories(id),
    unit_name TEXT NOT NULL DEFAULT 'ชิ้น',
    track_stock INTEGER NOT NULL DEFAULT 1 CHECK (track_stock IN (0, 1)),
    is_composite INTEGER NOT NULL DEFAULT 0 CHECK (is_composite IN (0, 1)),
    use_production INTEGER NOT NULL DEFAULT 0 CHECK (use_production IN (0, 1)),
    is_weighted_scale INTEGER NOT NULL DEFAULT 0 CHECK (is_weighted_scale IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE item_variants (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    variant_name TEXT NOT NULL DEFAULT 'ปกติ',
    sku TEXT NOT NULL UNIQUE,
    barcode TEXT UNIQUE,
    price_satang INTEGER NOT NULL DEFAULT 0 CHECK (price_satang >= 0),
    default_purchase_cost_micro_baht INTEGER NOT NULL DEFAULT 0 CHECK (default_purchase_cost_micro_baht >= 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE INDEX idx_item_variants_barcode ON item_variants(barcode);
CREATE INDEX idx_item_variants_sku ON item_variants(sku);

CREATE TABLE item_components (
    id TEXT PRIMARY KEY,
    composite_variant_id TEXT NOT NULL REFERENCES item_variants(id) ON DELETE CASCADE,
    component_variant_id TEXT NOT NULL REFERENCES item_variants(id) ON DELETE RESTRICT,
    component_role TEXT NOT NULL DEFAULT 'STANDARD' CHECK (
        component_role IN ('STANDARD', 'SWEETENER', 'MILK_BASE', 'COFFEE_SHOT', 'TEA_BASE', 'TOPPING', 'PACKAGING')
    ),
    quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
    wastage_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (wastage_basis_points >= 0),
    UNIQUE(composite_variant_id, component_variant_id),
    CHECK (composite_variant_id != component_variant_id)
);

CREATE TABLE modifier_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    selection_type TEXT NOT NULL CHECK (selection_type IN ('SINGLE', 'MULTIPLE')),
    min_selections INTEGER NOT NULL DEFAULT 0 CHECK (min_selections >= 0),
    max_selections INTEGER NOT NULL DEFAULT 1 CHECK (max_selections >= 1)
);

CREATE TABLE item_modifier_groups (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    modifier_group_id TEXT NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (item_id, modifier_group_id)
);

CREATE TABLE modifiers (
    id TEXT PRIMARY KEY,
    modifier_group_id TEXT NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price_delta_satang INTEGER NOT NULL DEFAULT 0,
    modifier_mode TEXT NOT NULL DEFAULT 'FIXED_QTY_DELTA' CHECK (modifier_mode IN ('FIXED_QTY_DELTA', 'ROLE_SCALE_BPS')),
    component_variant_id TEXT REFERENCES item_variants(id) ON DELETE SET NULL,
    quantity_delta_milli INTEGER NOT NULL DEFAULT 0,
    target_component_role TEXT CHECK (
        target_component_role IS NULL OR target_component_role IN ('STANDARD', 'SWEETENER', 'MILK_BASE', 'COFFEE_SHOT', 'TEA_BASE', 'TOPPING', 'PACKAGING')
    ),
    scale_basis_points INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- 4. Inventory Levels & Immutable Double-Entry Audit Ledger
CREATE TABLE inventory_levels (
    id TEXT PRIMARY KEY,
    outlet_id TEXT NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL REFERENCES item_variants(id) ON DELETE CASCADE,
    in_stock_milli INTEGER NOT NULL DEFAULT 0,
    average_cost_micro_baht INTEGER NOT NULL DEFAULT 0 CHECK (average_cost_micro_baht >= 0),
    optimal_stock_milli INTEGER NOT NULL DEFAULT 0,
    low_stock_threshold_milli INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(outlet_id, variant_id)
);

CREATE TABLE inventory_transactions (
    id TEXT PRIMARY KEY,
    outlet_id TEXT NOT NULL REFERENCES outlets(id),
    variant_id TEXT NOT NULL REFERENCES item_variants(id),
    transaction_type TEXT NOT NULL CHECK (
        transaction_type IN ('PO_RECEIVE', 'SALE_DIRECT', 'SALE_BOM', 'SALE_MODIFIER', 'VOID_RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT', 'RE_COUNT', 'PRODUCTION_BUILD')
    ),
    quantity_change_milli INTEGER NOT NULL,
    stock_before_milli INTEGER NOT NULL,
    stock_after_milli INTEGER NOT NULL,
    unit_cost_micro_baht INTEGER NOT NULL CHECK (unit_cost_micro_baht >= 0),
    reference_type TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    performed_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_inv_tx_outlet_variant_date ON inventory_transactions(outlet_id, variant_id, created_at);
CREATE INDEX idx_inv_tx_reference ON inventory_transactions(reference_type, reference_id);

-- Triggers enforcing Immutable Ledger on inventory_transactions and security_audit_logs
CREATE TRIGGER trg_prevent_inv_tx_update
BEFORE UPDATE ON inventory_transactions
BEGIN
    SELECT RAISE(ABORT, 'Immutable Ledger Violation: inventory_transactions cannot be updated');
END;

CREATE TRIGGER trg_prevent_inv_tx_delete
BEFORE DELETE ON inventory_transactions
BEGIN
    SELECT RAISE(ABORT, 'Immutable Ledger Violation: inventory_transactions cannot be deleted');
END;

CREATE TRIGGER trg_prevent_sec_audit_mutation
BEFORE DELETE ON security_audit_logs
BEGIN
    SELECT RAISE(ABORT, 'Immutable Audit Violation: security_audit_logs cannot be deleted');
END;

-- 5. Procurement, Landed Costs, Transfers, Adjustments & Stocktakes
CREATE TABLE suppliers (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    tax_id TEXT,
    phone TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE purchase_orders (
    id TEXT PRIMARY KEY,
    po_number TEXT NOT NULL UNIQUE,
    outlet_id TEXT NOT NULL REFERENCES outlets(id),
    supplier_id TEXT NOT NULL REFERENCES suppliers(id),
    status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')),
    subtotal_satang INTEGER NOT NULL DEFAULT 0,
    total_landed_cost_satang INTEGER NOT NULL DEFAULT 0,
    grand_total_satang INTEGER NOT NULL DEFAULT 0,
    received_at TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE purchase_order_items (
    id TEXT PRIMARY KEY,
    purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL REFERENCES item_variants(id),
    ordered_qty_milli INTEGER NOT NULL CHECK (ordered_qty_milli > 0),
    received_qty_milli INTEGER NOT NULL DEFAULT 0 CHECK (received_qty_milli >= 0),
    base_unit_cost_micro_baht INTEGER NOT NULL CHECK (base_unit_cost_micro_baht >= 0),
    allocated_landed_cost_micro_baht INTEGER NOT NULL DEFAULT 0 CHECK (allocated_landed_cost_micro_baht >= 0),
    effective_unit_cost_micro_baht INTEGER NOT NULL DEFAULT 0 CHECK (effective_unit_cost_micro_baht >= 0)
);

CREATE TABLE purchase_order_landed_costs (
    id TEXT PRIMARY KEY,
    purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    cost_type TEXT NOT NULL CHECK (cost_type IN ('FREIGHT', 'CUSTOMS_DUTY', 'INSURANCE', 'HANDLING', 'OTHER')),
    description TEXT NOT NULL,
    amount_satang INTEGER NOT NULL CHECK (amount_satang > 0)
);

CREATE TABLE transfer_orders (
    id TEXT PRIMARY KEY,
    transfer_number TEXT NOT NULL UNIQUE,
    source_outlet_id TEXT NOT NULL REFERENCES outlets(id),
    destination_outlet_id TEXT NOT NULL REFERENCES outlets(id),
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED')),
    dispatched_at TEXT,
    received_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (source_outlet_id != destination_outlet_id)
);

CREATE TABLE transfer_order_items (
    id TEXT PRIMARY KEY,
    transfer_order_id TEXT NOT NULL REFERENCES transfer_orders(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL REFERENCES item_variants(id),
    quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
    transfer_unit_cost_micro_baht INTEGER NOT NULL CHECK (transfer_unit_cost_micro_baht >= 0)
);

CREATE TABLE stock_adjustments (
    id TEXT PRIMARY KEY,
    adjustment_number TEXT NOT NULL UNIQUE,
    outlet_id TEXT NOT NULL REFERENCES outlets(id),
    reason_code TEXT NOT NULL CHECK (reason_code IN ('DAMAGED', 'EXPIRED', 'INTERNAL_USE', 'THEFT_LOSS', 'FOUND_SURPLUS', 'RE_COUNT')),
    notes TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE stock_adjustment_items (
    id TEXT PRIMARY KEY,
    stock_adjustment_id TEXT NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL REFERENCES item_variants(id),
    quantity_delta_milli INTEGER NOT NULL CHECK (quantity_delta_milli != 0),
    unit_cost_micro_baht INTEGER NOT NULL CHECK (unit_cost_micro_baht >= 0)
);

CREATE TABLE inventory_counts (
    id TEXT PRIMARY KEY,
    count_number TEXT NOT NULL UNIQUE,
    outlet_id TEXT NOT NULL REFERENCES outlets(id),
    status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
    total_variance_satang INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE inventory_count_items (
    id TEXT PRIMARY KEY,
    inventory_count_id TEXT NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL REFERENCES item_variants(id),
    expected_stock_milli INTEGER NOT NULL,
    counted_stock_milli INTEGER NOT NULL,
    variance_milli INTEGER NOT NULL,
    snapshot_unit_cost_micro_baht INTEGER NOT NULL,
    variance_cost_satang INTEGER NOT NULL
);

-- 6. Sales Orders (Idempotent + Thai ABB Tax Invoice), Modifiers, Anti-Fraud Payments & Sequence-Synced KDS
CREATE TABLE sales_orders (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    receipt_number TEXT NOT NULL UNIQUE,
    abb_tax_invoice_no TEXT UNIQUE,
    outlet_id TEXT NOT NULL REFERENCES outlets(id),
    terminal_id TEXT NOT NULL REFERENCES pos_terminals(id),
    shift_id TEXT NOT NULL REFERENCES pos_shifts(id),
    cashier_id TEXT NOT NULL REFERENCES users(id),
    order_type TEXT NOT NULL DEFAULT 'TAKEAWAY' CHECK (order_type IN ('RETAIL', 'DINE_IN', 'TAKEAWAY', 'DELIVERY')),
    table_or_queue_no TEXT,
    status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('OPEN', 'COMPLETED', 'VOIDED')),
    tax_mode TEXT NOT NULL DEFAULT 'INCLUSIVE' CHECK (tax_mode IN ('NONE', 'INCLUSIVE', 'EXCLUSIVE')),
    subtotal_satang INTEGER NOT NULL CHECK (subtotal_satang >= 0),
    discount_satang INTEGER NOT NULL DEFAULT 0 CHECK (discount_satang >= 0),
    tax_satang INTEGER NOT NULL DEFAULT 0 CHECK (tax_satang >= 0),
    total_satang INTEGER NOT NULL CHECK (total_satang >= 0),
    total_cogs_micro_baht INTEGER NOT NULL DEFAULT 0 CHECK (total_cogs_micro_baht >= 0),
    voided_by TEXT REFERENCES users(id),
    void_reason TEXT,
    voided_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_sales_orders_created_at ON sales_orders(outlet_id, created_at);
CREATE INDEX idx_sales_orders_shift ON sales_orders(shift_id);

CREATE TABLE sales_order_items (
    id TEXT PRIMARY KEY,
    sales_order_id TEXT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL REFERENCES item_variants(id),
    quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
    unit_price_satang INTEGER NOT NULL CHECK (unit_price_satang >= 0),
    modifiers_total_satang INTEGER NOT NULL DEFAULT 0,
    discount_satang INTEGER NOT NULL DEFAULT 0 CHECK (discount_satang >= 0),
    line_total_satang INTEGER NOT NULL CHECK (line_total_satang >= 0),
    line_cogs_micro_baht INTEGER NOT NULL DEFAULT 0 CHECK (line_cogs_micro_baht >= 0),
    notes TEXT
);

CREATE TABLE sales_order_item_modifiers (
    id TEXT PRIMARY KEY,
    sales_order_item_id TEXT NOT NULL REFERENCES sales_order_items(id) ON DELETE CASCADE,
    modifier_id TEXT NOT NULL REFERENCES modifiers(id),
    modifier_name_snapshot TEXT NOT NULL,
    price_delta_satang INTEGER NOT NULL,
    component_variant_id TEXT REFERENCES item_variants(id),
    deducted_qty_milli INTEGER NOT NULL DEFAULT 0,
    modifier_cogs_micro_baht INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE payment_transactions (
    id TEXT PRIMARY KEY,
    sales_order_id TEXT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
    payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'PROMPTPAY_QR', 'CARD', 'VOUCHER')),
    amount_satang INTEGER NOT NULL CHECK (amount_satang > 0),
    cash_tendered_satang INTEGER,
    change_given_satang INTEGER,
    emvco_payload_crc TEXT,
    sender_bank_code TEXT,
    slip_trans_ref_last4 TEXT,
    slip_trans_ref_hash TEXT UNIQUE,
    verified_by_user_id TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE kitchen_orders (
    sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    sales_order_id TEXT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
    outlet_id TEXT NOT NULL REFERENCES outlets(id),
    station TEXT NOT NULL DEFAULT 'MAIN',
    queue_number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT
);

CREATE INDEX idx_kitchen_orders_seq ON kitchen_orders(outlet_id, station, sequence_id);

CREATE TABLE kitchen_order_items (
    id TEXT PRIMARY KEY,
    kitchen_order_id TEXT NOT NULL REFERENCES kitchen_orders(id) ON DELETE CASCADE,
    sales_order_item_id TEXT NOT NULL REFERENCES sales_order_items(id) ON DELETE CASCADE,
    item_summary_text TEXT NOT NULL,
    modifiers_summary_text TEXT,
    quantity_milli INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE'))
);

