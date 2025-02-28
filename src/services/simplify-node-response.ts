import { SimplifiedLayout, buildSimplifiedLayout } from "~/transformers/layout";
import type {
  GetFileNodesResponse,
  Node as FigmaDocumentNode,
  Paint,
  Vector,
  RGBA,
  GetFileResponse,
} from "@figma/rest-api-spec";
import { hasValue, isStrokeWeights, isTruthy } from "~/utils/identity";
import {removeEmptyKeys, generateVarId, convertColor} from '~/utils/common'
/**
 * TDOO ITEMS
 *
 * - Improve color handling—room to simplify return types e.g. when only a single fill with opacity 1
 * - Improve stroke handling, combine with borderRadius
 * - Improve layout handling—translate from Figma vocabulary to CSS
 **/

// -------------------- SIMPLIFIED STRUCTURES --------------------

export type TextStyle = Partial<{
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: string;
  letterSpacing: string;
  textCase: string;
  textAlignHorizontal: string;
  textAlignVertical: string;
}>;
export type StrokeWeights = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};
type GlobalVars = Record<string, TextStyle | SimplifiedFill[] | SimplifiedLayout | StrokeWeights>;
export interface SimplifiedDesign {
  name: string;
  lastModified: string;
  nodes: SimplifiedNode[];
  globalVars: GlobalVars;
}

export interface SimplifiedComponent {
  key: string;
  name: string;
  description: string;
}

export interface SimplifiedComponentSet {
  key: string;
  name: string;
  description: string;
}

export interface SimplifiedNode {
  id: string;
  name?: string; // There is redundancy in the name field
  type: string; // e.g. FRAME, TEXT, INSTANCE, RECTANGLE, etc.
  // geometry
  boundingBox?: BoundingBox;
  // text
  text?: string;
  textStyle?: string;
  // appearance
  fill?: string;
  fills?: string;
  styles?: string;
  strokes?: string ;
  opacity?: number;
  borderRadius?: string;
  // layout & alignment
  layout?: string;
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

function parseGlobalVars(globalVars: GlobalVars, simplifiedNodes: SimplifiedNode[]): GlobalVars {
  // Reorganize vectorParents based on childrenId
  const childrenToParents: Record<string, string[]> = {};
  
  // Iterate through vectorParents, group by childrenId
  Object.entries(globalVars.vectorParents).forEach(([parentId, data]) => {
    const { childrenId } = data as { childrenId: string };
    
    if (!childrenToParents[childrenId]) {
      childrenToParents[childrenId] = [];
      delete globalVars[childrenId]
    }
    childrenToParents[childrenId].push(parentId);
  });
  
  
  if (simplifiedNodes.length){
    // Process parent nodes with the same childrenId
    Object.values(childrenToParents).forEach((parentIds) => {
      // Find all parent nodes
      parentIds.forEach(parentId => {
        let parentNode = findNodeById(parentId, simplifiedNodes);
        // If parent node is found, modify it directly
        if (parentNode) {
          // Save original size information
          const {id} = parentNode;
          Object.keys(parentNode).forEach(key => {
            delete parentNode[key as keyof SimplifiedNode];
          })
          Object.assign(parentNode, {
            id,
            type: "IMAGE"
          })
        }
      });
    });
  }


  // Store grouping results in globalVars
  globalVars.childrenToParents = childrenToParents;
  delete globalVars.vectorParents;
  return globalVars;
}

// ---------------------- PARSING ----------------------
export function parseFigmaFileResponse(data: GetFileResponse): SimplifiedDesign {
  const { name, lastModified, document } = data;
  let globalVars: Record<string, any> = {
    vectorParents: {}
  };
  const simplifiedNodes: SimplifiedNode[] = Object.values(document.children).map((n) =>
    parseNode(globalVars, n),
  ).filter((child) => child !== null && child !== undefined);
  globalVars = parseGlobalVars(globalVars, simplifiedNodes);

  return {
    name,
    lastModified,
    nodes: simplifiedNodes,
    globalVars,
  };
}

// Helper function to find node by ID
const findNodeById = (id: string, nodes: SimplifiedNode[]): SimplifiedNode | undefined => {
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
): string {
  // Check if the same value already exists
  const existingVarId = Object.entries(globalVars).find(
    ([_, existingValue]) => JSON.stringify(existingValue) === JSON.stringify(value)
  )?.[0];

  if (existingVarId) {
    return existingVarId;
  }

  // Create a new variable if it doesn't exist
  const varId = generateVarId();
  globalVars[varId] = value;
  return varId;
}

export function parseFigmaResponse(data: GetFileNodesResponse): SimplifiedDesign {
  const { name, lastModified, nodes } = data;
  let globalVars: Record<string, any> = {
    vectorParents: {}
  };
  
  const simplifiedNodes: (SimplifiedNode)[] = Object.values(nodes).map(
    (n) => parseNode(globalVars, n.document)
  ).filter((child) => child !== null && child !== undefined);
  
  globalVars = parseGlobalVars(globalVars, simplifiedNodes);

  return {
    name,
    lastModified,
    nodes: simplifiedNodes,
    globalVars,
  };
}


function parseNode(globalVars: Record<string, any>, n: FigmaDocumentNode, parent?: FigmaDocumentNode): SimplifiedNode | null {
  const { id, type, visible = true } = n;
  // Ignore invisible elements
  if (!visible) return null
  
  const simplified: SimplifiedNode = {
    id,
    type,
  };

  // text
  if (hasValue("style", n) && Object.keys(n.style).length) {
    const style = n.style;
    const textStyle = {
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      fontSize: style.fontSize,
      lineHeight: style.lineHeightPx ?? style.fontSize,
      letterSpacing:
        style.letterSpacing && style.letterSpacing !== 0
          ? style.letterSpacing
          : undefined,
      textCase: style.textCase,
      textAlignHorizontal: style.textAlignHorizontal,
      textAlignVertical: style.textAlignVertical,
    };
    simplified.textStyle = findOrCreateVar(globalVars, textStyle);
  }

  // fills & strokes
  if (hasValue("fills", n) && Array.isArray(n.fills) && n.fills.length) {
    const fills = n.fills.map(parsePaint);
    simplified.fills = findOrCreateVar(globalVars, fills);
  }
  if (hasValue("styles", n)) {
    simplified.styles = findOrCreateVar(globalVars, n.styles);
  }
  if (hasValue("strokes", n) && Array.isArray(n.strokes) && n.strokes.length) {
    const strokes = n.strokes.map(parsePaint);
    simplified.strokes = findOrCreateVar(globalVars, strokes);
  }

  // Process layout
  const layout = buildSimplifiedLayout(n, parent);
  if (Object.keys(layout).length > 1) {
    simplified.layout = findOrCreateVar(globalVars, layout);
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
    simplified.individualStrokeWeights = findOrCreateVar(globalVars, strokeWeights);
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

  // Detect VECTOR type nodes and store their parent node information
  if (type === "VECTOR") {
    // Cache VECTOR nodes, store directly using prefix
    const{ id: nodeId, ...vectorNodeData } = simplified;
    
    // Check if similar nodes already exist (ignoring id)
    const vectorId = findOrCreateVar(globalVars, vectorNodeData);
    
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
      type: "IMAGE",
      imageRef: raw.imageRef,
      scaleMode: raw.scaleMode,
    };
  } else if (raw.type === "SOLID") {
    // treat as SOLID
    const { hex, opacity } = convertColor(raw.color!, raw.opacity);
    return {
      type: "SOLID",
      hex,
      opacity,
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
        color: convertColor(color),
      })),
    };
  } else {
    throw new Error(`Unknown paint type: ${raw.type}`);
  }
}

