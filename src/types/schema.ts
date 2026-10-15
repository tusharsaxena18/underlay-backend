
export interface TableRow {
  [key: string]: string | number;
}

export interface ChartExtractionResult {
  label: string;
  estimatedValue: number;
  sourceSlide?: string;
  context?: string;
}

export interface NormalizedDocument {
  textBlocks: string[];
  tables: TableRow[][];
  chartOutputs: ChartExtractionResult[];
}