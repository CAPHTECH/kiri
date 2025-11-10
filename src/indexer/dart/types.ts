/**
 * TypeScript interfaces for Dart Analysis Server JSON-RPC protocol
 */

// JSON-RPC基本型
export interface RpcRequest<TParams = unknown> {
  id: string;
  method: string;
  params: TParams;
}

export interface RpcResponse<TResult = unknown> {
  id: string;
  result?: TResult;
  error?: RpcError;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcNotification<TParams = unknown> {
  event: string;
  params: TParams;
}

// Analysis Server プロトコル型

/**
 * analysis.updateContent のパラメータ
 */
export interface UpdateContentParams {
  files: Record<string, ContentOverlayChange>;
}

export type ContentOverlayChange = AddContentOverlay | RemoveContentOverlay;

export interface AddContentOverlay {
  type: "add";
  content: string;
}

export interface RemoveContentOverlay {
  type: "remove";
}

/**
 * analysis.getOutline のレスポンス
 */
export interface GetOutlineResult {
  outline: Outline;
}

export interface Outline {
  kind: string; // "LIBRARY" | "CLASS" | "FUNCTION" etc.
  name?: string;
  offset: number;
  length: number;
  element: OutlineElement;
  children?: Outline[];
}

export interface OutlineElement {
  kind: string; // ElementKind
  name: string;
  parameters?: string;
  returnType?: string;
  typeParameters?: string;
  location?: ElementLocation;
  dartdoc?: string;
}

export interface ElementLocation {
  file: string;
  offset: number;
  length: number;
  startLine: number;
  startColumn: number;
  endLine?: number;
  endColumn?: number;
}

/**
 * analysis.getNavigation のレスポンス
 */
export interface GetNavigationResult {
  files: string[];
  targets: NavigationTarget[];
  regions: NavigationRegion[];
}

export interface NavigationTarget {
  kind: string;
  fileIndex: number;
  offset: number;
  length: number;
  startLine: number;
  startColumn: number;
}

export interface NavigationRegion {
  offset: number;
  length: number;
  targets: number[]; // indices into NavigationTarget[]
}

/**
 * analysis.getLibraryDependencies のレスポンス
 */
export interface GetLibraryDependenciesResult {
  libraries: string[];
  packageMap: Record<string, string[]>;
}

/**
 * server.connected 通知
 */
export interface ServerConnectedParams {
  version: string;
  pid: number;
  sessionId?: string;
}

/**
 * server.error 通知
 */
export interface ServerErrorParams {
  isFatal: boolean;
  message: string;
  stackTrace: string;
}

/**
 * analysis.errors 通知
 */
export interface AnalysisErrorsParams {
  file: string;
  errors: AnalysisError[];
}

export interface AnalysisError {
  severity: "INFO" | "WARNING" | "ERROR";
  type: string;
  location: ElementLocation;
  message: string;
  correction?: string;
  code?: string;
}

// Dart Element Kinds (analysis server documentation)
// Phase 2で追加: EXTENSION_TYPE, OPERATOR, TYPE_ALIAS
export type ElementKind =
  | "CLASS"
  | "CLASS_TYPE_ALIAS"
  | "COMPILATION_UNIT"
  | "CONSTRUCTOR"
  | "ENUM"
  | "ENUM_CONSTANT"
  | "EXTENSION"
  | "EXTENSION_TYPE" // Dart 3.0+
  | "FIELD"
  | "FUNCTION"
  | "FUNCTION_TYPE_ALIAS"
  | "GETTER"
  | "LIBRARY"
  | "METHOD"
  | "MIXIN"
  | "OPERATOR" // オペレーターのオーバーロード
  | "PARAMETER"
  | "SETTER"
  | "TOP_LEVEL_VARIABLE"
  | "TYPE_ALIAS" // type Foo = Bar;
  | "TYPE_PARAMETER"
  | "UNIT_TEST_GROUP"
  | "UNIT_TEST_TEST"
  | "UNKNOWN";

/**
 * DartAnalysisClient が返す解析結果のペイロード
 */
export interface DartAnalysisPayload {
  outline: Outline;
  navigation?: GetNavigationResult;
  dependencies?: GetLibraryDependenciesResult;
}
