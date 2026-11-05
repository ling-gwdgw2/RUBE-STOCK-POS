//! Multi-Level BOM DAG Validation, Pre-Built Stopping Rule & Role-Based Modifiers (`bom_dag.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 5.2:
//! - DFS cycle detection (`HTTP 422 Circular BOM Dependency`)
//! - Stops BOM expansion at child nodes with `use_production == true`
//! - Applies Role-Based Modifier scaling (`ROLE_SCALE_BPS`, e.g., `SWEETENER` -5000 bps)
//! - Computes Multi-Level BOM Recipe COGS rollup in Micro-Baht using `i128` intermediate math

use crate::domains::math_i128::{
    round_div_i128, round_div_to_i64, FixedPointError, SCALE_BASIS_POINTS, SCALE_MILLI,
};
use rube_shared_contracts::{BasisPoints, ComponentRole, MicroBaht, MilliUnit, ModifierMode};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct BomComponentEdge {
    pub composite_variant_id: String,
    pub component_variant_id: String,
    pub component_role: ComponentRole,
    pub quantity_milli: MilliUnit,
    pub wastage_basis_points: BasisPoints,
}

#[derive(Debug, Clone)]
pub struct VariantStockSnapshot {
    pub variant_id: String,
    pub is_composite: bool,
    pub use_production: bool,
    pub average_cost_micro_baht: MicroBaht,
}

#[derive(Debug, Clone)]
pub struct AppliedModifierInput {
    pub modifier_mode: ModifierMode,
    pub component_variant_id: Option<String>,
    pub quantity_delta_milli: MilliUnit,
    pub target_component_role: Option<ComponentRole>,
    pub scale_basis_points: BasisPoints,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputedBomDeduction {
    pub variant_id: String,
    pub transaction_type: &'static str, // "SALE_DIRECT" | "SALE_BOM" | "SALE_MODIFIER"
    pub quantity_change_milli: MilliUnit,
    pub unit_cost_micro_baht: MicroBaht,
    pub line_cogs_micro_baht: MicroBaht,
}

/// Returns `Ok(())` if the BOM graph is a valid Directed Acyclic Graph (DAG),
/// or `Err(cycle_nodes)` if a cycle is detected.
pub fn validate_bom_dag_acyclic(edges: &[BomComponentEdge]) -> Result<(), Vec<String>> {
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in edges {
        if edge.composite_variant_id == edge.component_variant_id {
            return Err(vec![
                edge.composite_variant_id.clone(),
                edge.component_variant_id.clone(),
            ]);
        }
        adj.entry(edge.composite_variant_id.as_str())
            .or_default()
            .push(edge.component_variant_id.as_str());
    }

    let mut visited: HashSet<&str> = HashSet::new();
    let mut on_stack: HashSet<&str> = HashSet::new();
    let mut path: Vec<&str> = Vec::new();

    fn dfs<'a>(
        node: &'a str,
        adj: &HashMap<&'a str, Vec<&'a str>>,
        visited: &mut HashSet<&'a str>,
        on_stack: &mut HashSet<&'a str>,
        path: &mut Vec<&'a str>,
    ) -> Result<(), Vec<String>> {
        visited.insert(node);
        on_stack.insert(node);
        path.push(node);

        if let Some(neighbors) = adj.get(node) {
            for &next in neighbors {
                if on_stack.contains(next) {
                    let start_idx = path.iter().position(|&n| n == next).unwrap_or(0);
                    let mut cycle: Vec<String> =
                        path[start_idx..].iter().map(|&s| s.to_string()).collect();
                    cycle.push(next.to_string());
                    return Err(cycle);
                }
                if !visited.contains(next) {
                    dfs(next, adj, visited, on_stack, path)?;
                }
            }
        }

        path.pop();
        on_stack.remove(node);
        Ok(())
    }

    for &node in adj.keys() {
        if !visited.contains(node) {
            dfs(node, &adj, &mut visited, &mut on_stack, &mut path)?;
        }
    }

    Ok(())
}

/// Computes multi-level BOM stock deductions with the Pre-Built Stopping Rule (`use_production = true`)
/// and Role-Based Modifiers (`ROLE_SCALE_BPS`).
pub fn compute_multilevel_bom_deductions(
    root_variant: &VariantStockSnapshot,
    sold_qty_milli: MilliUnit,
    modifiers: &[AppliedModifierInput],
    catalog: &HashMap<String, VariantStockSnapshot>,
    edges: &[BomComponentEdge],
) -> Result<Vec<ComputedBomDeduction>, FixedPointError> {
    if sold_qty_milli <= 0 {
        return Err(FixedPointError::NonPositiveQuantity(sold_qty_milli));
    }

    let mut role_scales: HashMap<ComponentRole, i128> = HashMap::new();
    for m in modifiers {
        if m.modifier_mode == ModifierMode::RoleScaleBps {
            if let Some(role) = m.target_component_role {
                *role_scales.entry(role).or_insert(0) += m.scale_basis_points as i128;
            }
        }
    }

    let mut results = Vec::new();
    let q_sold = sold_qty_milli as i128;

    if !root_variant.is_composite {
        let cogs = round_div_to_i64(
            q_sold * (root_variant.average_cost_micro_baht as i128),
            SCALE_MILLI,
        )?;
        results.push(ComputedBomDeduction {
            variant_id: root_variant.variant_id.clone(),
            transaction_type: "SALE_DIRECT",
            quantity_change_milli: -sold_qty_milli,
            unit_cost_micro_baht: root_variant.average_cost_micro_baht,
            line_cogs_micro_baht: cogs,
        });
    } else {
        fn expand_recursive(
            parent_id: &str,
            parent_multiplier_milli: i128,
            role_scales: &HashMap<ComponentRole, i128>,
            catalog: &HashMap<String, VariantStockSnapshot>,
            edges: &[BomComponentEdge],
            out: &mut Vec<ComputedBomDeduction>,
        ) -> Result<(), FixedPointError> {
            for edge in edges.iter().filter(|e| e.composite_variant_id == parent_id) {
                let Some(child) = catalog.get(&edge.component_variant_id) else {
                    continue;
                };

                let scale_delta = role_scales.get(&edge.component_role).copied().unwrap_or(0);
                let factor_bps = (SCALE_BASIS_POINTS + scale_delta).max(0);
                let scaled_recipe_qty =
                    round_div_i128((edge.quantity_milli as i128) * factor_bps, SCALE_BASIS_POINTS)?;

                let cumulative_qty = round_div_i128(
                    parent_multiplier_milli
                        * scaled_recipe_qty
                        * (SCALE_BASIS_POINTS + (edge.wastage_basis_points as i128)),
                    SCALE_MILLI * SCALE_BASIS_POINTS,
                )?;

                if child.is_composite && !child.use_production {
                    expand_recursive(
                        &child.variant_id,
                        cumulative_qty,
                        role_scales,
                        catalog,
                        edges,
                        out,
                    )?;
                } else if cumulative_qty > 0 {
                    let qty_i64 = i64::try_from(cumulative_qty)
                        .map_err(|_| FixedPointError::OverflowI64(cumulative_qty))?;
                    let cogs = round_div_to_i64(
                        cumulative_qty * (child.average_cost_micro_baht as i128),
                        SCALE_MILLI,
                    )?;
                    out.push(ComputedBomDeduction {
                        variant_id: child.variant_id.clone(),
                        transaction_type: "SALE_BOM",
                        quantity_change_milli: -qty_i64,
                        unit_cost_micro_baht: child.average_cost_micro_baht,
                        line_cogs_micro_baht: cogs,
                    });
                }
            }
            Ok(())
        }

        expand_recursive(
            &root_variant.variant_id,
            q_sold,
            &role_scales,
            catalog,
            edges,
            &mut results,
        )?;
    }

    for m in modifiers {
        if m.modifier_mode == ModifierMode::FixedQtyDelta && m.quantity_delta_milli != 0 {
            if let Some(ref comp_id) = m.component_variant_id {
                if let Some(comp) = catalog.get(comp_id) {
                    let delta = round_div_to_i64(
                        q_sold * (m.quantity_delta_milli as i128),
                        SCALE_MILLI,
                    )?;
                    if delta != 0 {
                        let abs_delta = (delta as i128).abs();
                        let cogs = round_div_to_i64(
                            abs_delta * (comp.average_cost_micro_baht as i128),
                            SCALE_MILLI,
                        )?;
                        results.push(ComputedBomDeduction {
                            variant_id: comp.variant_id.clone(),
                            transaction_type: "SALE_MODIFIER",
                            quantity_change_milli: -delta,
                            unit_cost_micro_baht: comp.average_cost_micro_baht,
                            line_cogs_micro_baht: cogs,
                        });
                    }
                }
            }
        }
    }

    Ok(results)
}
