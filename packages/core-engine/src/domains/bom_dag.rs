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

    if !root_variant.is_composite || root_variant.use_production {
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
        // Accumulate total leaf quantities first to avoid diamond DAG multi-path rounding drift
        let mut leaf_qty_by_id: HashMap<String, i128> = HashMap::new();
        let mut leaf_order: Vec<String> = Vec::new();

        fn expand_recursive(
            parent_id: &str,
            parent_multiplier_milli: i128,
            role_scales: &HashMap<ComponentRole, i128>,
            scaled_roles_in_ancestors: &HashSet<ComponentRole>,
            catalog: &HashMap<String, VariantStockSnapshot>,
            edges: &[BomComponentEdge],
            leaf_qty_by_id: &mut HashMap<String, i128>,
            leaf_order: &mut Vec<String>,
        ) -> Result<(), FixedPointError> {
            for edge in edges.iter().filter(|e| e.composite_variant_id == parent_id) {
                let Some(child) = catalog.get(&edge.component_variant_id) else {
                    return Err(FixedPointError::MissingComponentVariant(
                        edge.component_variant_id.clone(),
                    ));
                };

                let already_scaled = edge.component_role != ComponentRole::Standard
                    && scaled_roles_in_ancestors.contains(&edge.component_role);
                let scale_delta = if already_scaled {
                    0
                } else {
                    role_scales.get(&edge.component_role).copied().unwrap_or(0)
                };
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
                    let mut next_scaled_roles = scaled_roles_in_ancestors.clone();
                    if edge.component_role != ComponentRole::Standard
                        && role_scales.contains_key(&edge.component_role)
                    {
                        next_scaled_roles.insert(edge.component_role);
                    }
                    expand_recursive(
                        &child.variant_id,
                        cumulative_qty,
                        role_scales,
                        &next_scaled_roles,
                        catalog,
                        edges,
                        leaf_qty_by_id,
                        leaf_order,
                    )?;
                } else if cumulative_qty > 0 {
                    match leaf_qty_by_id.get_mut(&child.variant_id) {
                        Some(total) => *total += cumulative_qty,
                        None => {
                            leaf_order.push(child.variant_id.clone());
                            leaf_qty_by_id.insert(child.variant_id.clone(), cumulative_qty);
                        }
                    }
                }
            }
            Ok(())
        }

        expand_recursive(
            &root_variant.variant_id,
            q_sold,
            &role_scales,
            &HashSet::new(),
            catalog,
            edges,
            &mut leaf_qty_by_id,
            &mut leaf_order,
        )?;

        for variant_id in leaf_order {
            let total_qty = leaf_qty_by_id[&variant_id];
            let Some(leaf_variant) = catalog.get(&variant_id) else {
                return Err(FixedPointError::MissingComponentVariant(variant_id));
            };
            let qty_i64 = i64::try_from(total_qty)
                .map_err(|_| FixedPointError::OverflowI64(total_qty))?;
            let cogs = round_div_to_i64(
                total_qty * (leaf_variant.average_cost_micro_baht as i128),
                SCALE_MILLI,
            )?;
            results.push(ComputedBomDeduction {
                variant_id,
                transaction_type: "SALE_BOM",
                quantity_change_milli: -qty_i64,
                unit_cost_micro_baht: leaf_variant.average_cost_micro_baht,
                line_cogs_micro_baht: cogs,
            });
        }
    }

    for m in modifiers {
        if m.modifier_mode == ModifierMode::FixedQtyDelta && m.quantity_delta_milli != 0 {
            if let Some(ref comp_id) = m.component_variant_id {
                let Some(comp) = catalog.get(comp_id) else {
                    return Err(FixedPointError::MissingComponentVariant(comp_id.clone()));
                };
                let delta = round_div_to_i64(
                    q_sold * (m.quantity_delta_milli as i128),
                    SCALE_MILLI,
                )?;
                if delta != 0 {
                    let signed_cogs = round_div_to_i64(
                        (delta as i128) * (comp.average_cost_micro_baht as i128),
                        SCALE_MILLI,
                    )?;
                    results.push(ComputedBomDeduction {
                        variant_id: comp.variant_id.clone(),
                        transaction_type: "SALE_MODIFIER",
                        quantity_change_milli: -delta,
                        unit_cost_micro_baht: comp.average_cost_micro_baht,
                        line_cogs_micro_baht: signed_cogs,
                    });
                }
            }
        }
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bom_dag_cycle_and_double_scale_guard_and_signed_modifier_cogs() {
        let mut catalog = HashMap::new();
        catalog.insert(
            "DRINK".to_string(),
            VariantStockSnapshot {
                variant_id: "DRINK".to_string(),
                is_composite: true,
                use_production: false,
                average_cost_micro_baht: 0,
            },
        );
        catalog.insert(
            "SUB_SWEET".to_string(),
            VariantStockSnapshot {
                variant_id: "SUB_SWEET".to_string(),
                is_composite: true,
                use_production: false,
                average_cost_micro_baht: 0,
            },
        );
        catalog.insert(
            "RAW_HONEY".to_string(),
            VariantStockSnapshot {
                variant_id: "RAW_HONEY".to_string(),
                is_composite: false,
                use_production: false,
                average_cost_micro_baht: 250_000,
            },
        );

        let edges = vec![
            BomComponentEdge {
                composite_variant_id: "DRINK".to_string(),
                component_variant_id: "SUB_SWEET".to_string(),
                component_role: ComponentRole::Sweetener,
                quantity_milli: 1_000,
                wastage_basis_points: 0,
            },
            BomComponentEdge {
                composite_variant_id: "SUB_SWEET".to_string(),
                component_variant_id: "RAW_HONEY".to_string(),
                component_role: ComponentRole::Sweetener,
                quantity_milli: 20_000,
                wastage_basis_points: 0,
            },
        ];

        assert!(validate_bom_dag_acyclic(&edges).is_ok());

        let modifiers = vec![
            AppliedModifierInput {
                modifier_mode: ModifierMode::RoleScaleBps,
                component_variant_id: None,
                quantity_delta_milli: 0,
                target_component_role: Some(ComponentRole::Sweetener),
                scale_basis_points: -5_000,
            },
            AppliedModifierInput {
                modifier_mode: ModifierMode::FixedQtyDelta,
                component_variant_id: Some("RAW_HONEY".to_string()),
                quantity_delta_milli: -4_000,
                target_component_role: None,
                scale_basis_points: 0,
            },
        ];

        let deds = compute_multilevel_bom_deductions(
            catalog.get("DRINK").unwrap(),
            1_000,
            &modifiers,
            &catalog,
            &edges,
        )
        .unwrap();

        assert_eq!(deds.len(), 2);
        assert_eq!(deds[0].quantity_change_milli, -10_000);
        assert_eq!(deds[1].quantity_change_milli, 4_000);
        assert!(deds[1].line_cogs_micro_baht < 0);
    }

    #[test]
    fn test_prebuilt_direct_sale_and_diamond_dag_no_rounding_drift() {
        let mut catalog = HashMap::new();
        catalog.insert(
            "PREBUILT_BOBA".to_string(),
            VariantStockSnapshot {
                variant_id: "PREBUILT_BOBA".to_string(),
                is_composite: true,
                use_production: true,
                average_cost_micro_baht: 80_000_000,
            },
        );
        catalog.insert(
            "DRY_BOBA".to_string(),
            VariantStockSnapshot {
                variant_id: "DRY_BOBA".to_string(),
                is_composite: false,
                use_production: false,
                average_cost_micro_baht: 50_000_000,
            },
        );

        let prebuilt_edges = vec![BomComponentEdge {
            composite_variant_id: "PREBUILT_BOBA".to_string(),
            component_variant_id: "DRY_BOBA".to_string(),
            component_role: ComponentRole::Standard,
            quantity_milli: 500,
            wastage_basis_points: 0,
        }];

        let prebuilt_deds = compute_multilevel_bom_deductions(
            catalog.get("PREBUILT_BOBA").unwrap(),
            2_000,
            &[],
            &catalog,
            &prebuilt_edges,
        )
        .unwrap();
        assert_eq!(prebuilt_deds.len(), 1);
        assert_eq!(prebuilt_deds[0].variant_id, "PREBUILT_BOBA");
        assert_eq!(prebuilt_deds[0].transaction_type, "SALE_DIRECT");
        assert_eq!(prebuilt_deds[0].quantity_change_milli, -2_000);
        assert_eq!(prebuilt_deds[0].line_cogs_micro_baht, 160_000_000);

        // Diamond DAG: ROOT -> SUB_A (500 milli) & ROOT -> SUB_B (500 milli), both -> LEAF (1 milli)
        // With leaf avg cost = 500 micro-baht: each path qty = 1 milli -> 1*500/1000 = 0.5 -> rounds to 1 separately (sum=2),
        // whereas combined qty = 2 milli -> 2*500/1000 = 1 (exact, zero drift!)
        catalog.insert(
            "ROOT".to_string(),
            VariantStockSnapshot {
                variant_id: "ROOT".to_string(),
                is_composite: true,
                use_production: false,
                average_cost_micro_baht: 0,
            },
        );
        catalog.insert(
            "SUB_A".to_string(),
            VariantStockSnapshot {
                variant_id: "SUB_A".to_string(),
                is_composite: true,
                use_production: false,
                average_cost_micro_baht: 0,
            },
        );
        catalog.insert(
            "SUB_B".to_string(),
            VariantStockSnapshot {
                variant_id: "SUB_B".to_string(),
                is_composite: true,
                use_production: false,
                average_cost_micro_baht: 0,
            },
        );
        catalog.insert(
            "LEAF".to_string(),
            VariantStockSnapshot {
                variant_id: "LEAF".to_string(),
                is_composite: false,
                use_production: false,
                average_cost_micro_baht: 500,
            },
        );

        let diamond_edges = vec![
            BomComponentEdge {
                composite_variant_id: "ROOT".to_string(),
                component_variant_id: "SUB_A".to_string(),
                component_role: ComponentRole::Standard,
                quantity_milli: 1_000,
                wastage_basis_points: 0,
            },
            BomComponentEdge {
                composite_variant_id: "ROOT".to_string(),
                component_variant_id: "SUB_B".to_string(),
                component_role: ComponentRole::Standard,
                quantity_milli: 1_000,
                wastage_basis_points: 0,
            },
            BomComponentEdge {
                composite_variant_id: "SUB_A".to_string(),
                component_variant_id: "LEAF".to_string(),
                component_role: ComponentRole::Standard,
                quantity_milli: 1,
                wastage_basis_points: 0,
            },
            BomComponentEdge {
                composite_variant_id: "SUB_B".to_string(),
                component_variant_id: "LEAF".to_string(),
                component_role: ComponentRole::Standard,
                quantity_milli: 1,
                wastage_basis_points: 0,
            },
        ];

        let diamond_deds = compute_multilevel_bom_deductions(
            catalog.get("ROOT").unwrap(),
            1_000,
            &[],
            &catalog,
            &diamond_edges,
        )
        .unwrap();
        assert_eq!(diamond_deds.len(), 1);
        assert_eq!(diamond_deds[0].variant_id, "LEAF");
        assert_eq!(diamond_deds[0].quantity_change_milli, -2);
        assert_eq!(diamond_deds[0].line_cogs_micro_baht, 1);
    }
}
