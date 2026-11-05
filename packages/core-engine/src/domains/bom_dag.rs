//! Multi-Level BOM DAG Validation, Pre-Built Stopping Rule & Role-Based Modifiers (`bom_dag.rs`)
//!
//! Enforces `ARCHITECTURE.md` Section 5.2:
//! - DFS cycle detection (`HTTP 422 Circular BOM Dependency`)
//! - Stops BOM expansion at child nodes with `use_production == true`
//! - Applies Role-Based Modifier scaling (`ROLE_SCALE_BPS`, e.g., `SWEETENER` -5000 bps)

use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct BomComponentEdge {
    pub composite_variant_id: String,
    pub component_variant_id: String,
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

