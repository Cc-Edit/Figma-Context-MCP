import { SimplifiedLayout, buildSimplifiedLayout } from "~/transformers/layout";
import type {
  GetFileNodesResponse,
  Node as FigmaDocumentNode,
  Paint,
  Vector,
  RGBA,
} from "@figma/rest-api-spec";
import { hasValue, isStrokeWeights, isTruthy } from "~/utils/identity";
import {removeEmptyKeys, formatRGBAColor, convertColor, generateVarId} from '~/utils/common'
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

// 根据 ID 查找节点的辅助函数
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
 * 查找或创建全局变量
 * @param globalVars - 全局变量对象
 * @param value - 要存储的值
 * @param prefix - 变量ID前缀
 * @returns 变量ID
 */
function findOrCreateVar(
  globalVars: Record<string, any>, 
  value: any, 
  prefix: string
): string {
  // 查找是否存在相同的值
  const existingVarId = Object.entries(globalVars).find(
    ([_, existingValue]) => JSON.stringify(existingValue) === JSON.stringify(value)
  )?.[0];

  if (existingVarId) {
    return existingVarId;
  }

  // 不存在则创建新的变量
  const varId = generateVarId(prefix);
  globalVars[varId] = value;
  return varId;
}

export function parseFigmaResponse(data: GetFileNodesResponse, fileKey: string): SimplifiedDesign {
  const { name, lastModified, thumbnailUrl, nodes } = data;
  const globalVars: Record<string, any> = {
    vectorParents: {}
  };
  
  const simplifiedNodes: (SimplifiedNode | null)[] = Object.values(nodes).map(
    (n) => parseNode(globalVars, n.document)
  );
  // 
  
  // 根据 childrenId 重组 vectorParents
  const childrenToParents: Record<string, string[]> = {};
  
  // 遍历 vectorParents，按 childrenId 分组
  Object.entries(globalVars.vectorParents).forEach(([parentId, data]) => {
    const { childrenId } = data as { childrenId: string };
    
    if (!childrenToParents[childrenId]) {
      childrenToParents[childrenId] = [];
    }
    
    childrenToParents[childrenId].push(parentId);
  });
  
  
  if (simplifiedNodes !== null){
    // 处理每组相同 childrenId 的父节点
    Object.values(childrenToParents).forEach((parentIds) => {
      const imageRef = `https://api.figma.com/v1/images/${fileKey}?ids=${parentIds[0]}`
      // 查找所有父节点
      parentIds.forEach(parentId => {
        let parentNode = findNodeById(parentId, simplifiedNodes);
        // 如果找到了父节点，直接修改它
        if (parentNode) {
          // 保存原始尺寸信息
          const {id, size} = parentNode;
          Object.keys(parentNode).forEach(key => {
            delete parentNode[key as keyof SimplifiedNode];
          })
          Object.assign(parentNode, {
            id,
            name: "Image",
            type: "IMAGE",
            size,
            fills:[
              {
                type: "IMAGE",
                scaleMode: "FILL",
                imageRef: imageRef,
                imageType: 'png',
                opacity: 1
              }
            ]
          })
        }
      });
    });
  }


  // 将分组结果存储到 globalVars
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

  // 处理文本样式
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

  // 处理布局
  const layout = buildSimplifiedLayout(n, parent);
  if (layout) {
    simplified.layout = findOrCreateVar(globalVars, layout, 'layout');
  }

  // 其他简单属性直接保留
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

  // 递归处理子节点
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

  // 检测 VECTOR 类型节点并存储其父节点信息
  if (type === "VECTOR") {
    // 缓存 VECTOR 节点，使用前缀直接存储
    const{ id: nodeId, ...vectorNodeData } = simplified;
    
    // 查找是否已存在相似的节点（忽略id）
    const vectorId = findOrCreateVar(globalVars, vectorNodeData, 'vector');
    
    // 如果有父节点，存储关联信息
    if (parent) {
      // 存储 VECTOR 节点的父节点信息
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

