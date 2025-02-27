import { SimplifiedLayout, buildSimplifiedLayout } from "~/transformers/layout";
import type {
  GetFileNodesResponse,
  Node as FigmaDocumentNode,
  Paint,
  Vector,
  RGBA,
} from "@figma/rest-api-spec";
import { hasValue, isStrokeWeights, isTruthy } from "~/utils/identity";
import {removeEmptyKeys, formatRGBAColor, generateVarId} from '~/utils/common'
/**
 * TDOO ITEMS
 *
 * - Improve color handling—room to simplify return types e.g. when only a single fill with opacity 1
 * - Improve stroke handling, combine with borderRadius
 * - Improve layout handling—translate from Figma vocabulary to CSS
 **/

// -------------------- SIMPLIFIED STRUCTURES --------------------

export interface SimplifiedDesign {
  name: string;
  lastModified: string;
  thumbnailUrl: string;
  // If we want to preserve components data, we can stash it
  nodes: (SimplifiedNode | null)[];
  components?: Record<string, SimplifiedComponent>;
  componentSets?: Record<string, SimplifiedComponentSet>;
  globalVars: Record<string, any>;
}

export interface SimplifiedComponent {
  key: string;
  name: string;
  description: string;
  // etc. Expand as needed
}

export interface SimplifiedComponentSet {
  key: string;
  name: string;
  description: string;
  // etc. Expand as needed
}

export interface SimplifiedNode {
  id: string;
  name: string;
  type: string; // e.g. FRAME, TEXT, INSTANCE, RECTANGLE, etc.
  size?: {};
  // geometry
  boundingBox?: BoundingBox;
  // text
  text?: string;
  textStyle?: string;
  // appearance
  fill?: string;
  fills?: SimplifiedFill[] | string;
  styles?: string;
  strokes?: SimplifiedFill[] | string ;
  opacity?: number;
  borderRadius?: string;
  // layout & alignment
  layout?: SimplifiedLayout | string;
  // backgroundColor?: ColorValue; // Deprecated by Figma API
  // for rect-specific strokes, etc.
  strokeWeight?: number;
  strokeDashes?: number[];
  individualStrokeWeights?: string;
  // children
  children?: SimplifiedNode[];
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SimplifiedFill {
  type?: Paint["type"];
  hex?: string;
  rgba?: string;
  opacity?: number;
  imageRef?: string;
  scaleMode?: string;
  gradientHandlePositions?: Vector[];
  gradientStops?: {
    position: number;
    color: ColorValue | string;
  }[];
}

export interface ColorValue {
  hex: string;
  opacity: number;
}

// ---------------------- PARSING ----------------------

// Helper function to find node by ID
const findNodeById = (id: string, nodes: (SimplifiedNode | null)[]): SimplifiedNode | undefined => {
  for (const node of nodes) {
    if (node?.id === id) {
      return node;
    }
    
    if (node?.children && node.children.length > 0) {
      const foundInChildren = findNodeById(id, node.children);
      if (foundInChildren) {
        return foundInChildren;
      }
    }
  }
  
  return undefined;
};


/**
 * Find or create global variables
 * @param globalVars - Global variables object
 * @param value - Value to store
 * @param prefix - Variable ID prefix
 * @returns Variable ID
 */
function findOrCreateVar(
  globalVars: Record<string, any>, 
  value: any, 
  prefix: string
): string {
  // Check if the same value already exists
  const existingVarId = Object.entries(globalVars).find(
    ([_, existingValue]) => JSON.stringify(existingValue) === JSON.stringify(value)
  )?.[0];

  if (existingVarId) {
    return existingVarId;
  }

  // Create a new variable if it doesn't exist
  const varId = generateVarId(prefix);
  globalVars[varId] = value;
  return varId;
}

export function parseFigmaResponse(data: GetFileNodesResponse): SimplifiedDesign {
  const { name, lastModified, thumbnailUrl, nodes } = data;
  const globalVars: Record<string, any> = {
    vectorParents: {}
  };
  
  const simplifiedNodes: (SimplifiedNode | null)[] = Object.values(nodes).map(
    (n) => parseNode(globalVars, n.document)
  );
  // 
  
  // Reorganize vectorParents based on childrenId
  const childrenToParents: Record<string, string[]> = {};
  
  // Iterate through vectorParents, group by childrenId
  Object.entries(globalVars.vectorParents).forEach(([parentId, data]) => {
    const { childrenId } = data as { childrenId: string };
    
    if (!childrenToParents[childrenId]) {
      childrenToParents[childrenId] = [];
    }
    
    childrenToParents[childrenId].push(parentId);
  });
  
  
  if (simplifiedNodes !== null){
    // Process parent nodes with the same childrenId
    Object.values(childrenToParents).forEach((parentIds) => {
      // Find all parent nodes
      parentIds.forEach(parentId => {
        let parentNode = findNodeById(parentId, simplifiedNodes);
        // If parent node is found, modify it directly
        if (parentNode) {
          // Save original size information
          const {id, size} = parentNode;
          Object.keys(parentNode).forEach(key => {
            delete parentNode[key as keyof SimplifiedNode];
          })
          Object.assign(parentNode, {
            id,
            name: "Image",
            type: "IMAGE",
            size
          })
        }
      });
    });
  }


  // Store grouping results in globalVars
  globalVars.childrenToParents = childrenToParents;
  delete globalVars.vectorParents;

  return {
    name,
    lastModified,
    thumbnailUrl,
    nodes: simplifiedNodes,
    globalVars,
  };
}


function parseNode(globalVars: Record<string, any>, n: FigmaDocumentNode, parent?: FigmaDocumentNode): SimplifiedNode | null {
  const { id, name, type, visible = true } = n;
  if (!visible) return null
  
  const simplified: SimplifiedNode = {
    id,
    name,
    type,
  };

  // text
  if (hasValue("style", n) && Object.keys(n.style).length) {
    const textStyle = {
      fontFamily: n.style.fontFamily,
      fontWeight: n.style.fontWeight,
      fontSize: n.style.fontSize,
      lineHeight: n.style.lineHeightPx ? `${n.style.lineHeightPx}px` : undefined,
      letterSpacing: n.style.letterSpacing ? `${n.style.letterSpacing}px` : undefined,
      textCase: n.style.textCase,
      textAlignHorizontal: n.style.textAlignHorizontal,
      textAlignVertical: n.style.textAlignVertical,
    };
    simplified.textStyle = findOrCreateVar(globalVars, textStyle, 'style');
  }

  // fills & strokes
  if (hasValue("fills", n) && Array.isArray(n.fills) && n.fills.length) {
    const fills = n.fills.map(parsePaint);
    simplified.fills = findOrCreateVar(globalVars, fills, 'fill');
  }
  if (hasValue("styles", n)) {
    simplified.styles = JSON.stringify(n.styles);
  }
  if (hasValue("strokes", n) && Array.isArray(n.strokes) && n.strokes.length) {
    const strokes = n.strokes.map(parsePaint);
    simplified.strokes = findOrCreateVar(globalVars, strokes, 'stroke');
  }

  // Process layout
  const layout = buildSimplifiedLayout(n, parent);
  if (Object.keys(layout).length > 1) {
    simplified.layout = findOrCreateVar(globalVars, layout, 'layout');
  }

  // Keep other simple properties directly
  if (hasValue("characters", n, isTruthy)) {
    simplified.text = n.characters;
  }

  // border/corner
  if (
    hasValue("strokeWeight", n) &&
    typeof n.strokeWeight === "number" &&
    simplified.strokes?.length
  ) {
    simplified.strokeWeight = n.strokeWeight;
  }
  if (hasValue("strokeDashes", n) && Array.isArray(n.strokeDashes) && n.strokeDashes.length) {
    simplified.strokeDashes = n.strokeDashes;
  }

  if (hasValue("individualStrokeWeights", n, isStrokeWeights)) {
    const strokeWeights = {
      top: n.individualStrokeWeights.top,
      right: n.individualStrokeWeights.right,
      bottom: n.individualStrokeWeights.bottom,
      left: n.individualStrokeWeights.left,
    };
    simplified.individualStrokeWeights = findOrCreateVar(globalVars, strokeWeights, 'weights');
  }

  // opacity
  if (hasValue("opacity", n) && typeof n.opacity === "number") {
    simplified.opacity = n.opacity;
  }

  if (hasValue("cornerRadius", n) && typeof n.cornerRadius === "number") {
    simplified.borderRadius = `${n.cornerRadius}px`;
  }

  // Recursively process child nodes
  if (hasValue("children", n) && n.children.length > 0) {
    let children =  n.children.map((child) => parseNode(globalVars, child, n)).filter((child) => child !== null && child !== undefined);
    if (children.length){
      simplified.children = children
    }
  }
  
  if (hasValue("absoluteBoundingBox", n)) {
    const { width, height } = n.absoluteBoundingBox || {};
    simplified.size = {
      width,
      height
    }
  }

  // Detect VECTOR type nodes and store their parent node information
  if (type === "VECTOR") {
    // Cache VECTOR nodes, store directly using prefix
    const{ id: nodeId, ...vectorNodeData } = simplified;
    
    // Check if similar nodes already exist (ignoring id)
    const vectorId = findOrCreateVar(globalVars, vectorNodeData, 'vector');
    
    // If there is a parent node, store relationship information
    if (parent) {
      // Store parent node information of the VECTOR node
      globalVars.vectorParents[parent.id] = {
        parentId: parent.id,
        parentName: parent.name,
        parentType: parent.type,
        childrenId: vectorId
      };
    }
  }

  return removeEmptyKeys(simplified);
}

function parsePaint(raw: Paint): SimplifiedFill {
  if (raw.type === "IMAGE") {
    return {
      imageRef: raw.imageRef,
      scaleMode: raw.scaleMode,
    };
  } else if (raw.type === "SOLID") {
    return {
      rgba: formatRGBAColor(raw.color!, raw.opacity)
    };
  } else if (
    ["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"].includes(
      raw.type,
    )
  ) {
    // treat as GRADIENT_LINEAR
    return {
      type: raw.type,
      gradientHandlePositions: raw.gradientHandlePositions,
      gradientStops: raw.gradientStops.map(({ position, color }) => ({
        position,
        color: formatRGBAColor(color),
      })),
    };
  } else {
    throw new Error(`Unknown paint type: ${raw.type}`);
  }
}

