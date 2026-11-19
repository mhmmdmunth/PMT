/**
 * Utility for evaluating Excel-style formulas in spreadsheet cells.
 * Supports expressions starting with '=', arithmetic operations (+, -, *, /, %, ^),
 * Indonesian decimal commas, nested parentheses, and functions (SUM, AVG, MIN, MAX, ABS, ROUND, SQRT).
 */

export interface FormulaResult {
  isFormula: boolean;
  result: any;
  originalFormula?: string;
  isError?: boolean;
}

export function evaluateExcelFormula(rawValue: any): FormulaResult {
  if (typeof rawValue !== 'string') {
    return { isFormula: false, result: rawValue };
  }

  const trimmed = rawValue.trim();
  if (!trimmed.startsWith('=')) {
    return { isFormula: false, result: rawValue };
  }

  const originalFormula = trimmed;
  let expr = trimmed.substring(1).trim();

  if (!expr) {
    return { isFormula: true, result: '', originalFormula };
  }

  try {
    // 1. Convert Indonesian decimal commas between digits to dots (e.g. "300,5 * 2" -> "300.5 * 2")
    expr = expr.replace(/(\d+),(\d+)/g, '$1.$2');

    // 2. Process helper functions
    // SUM(a, b, c) -> (a+b+c)
    expr = expr.replace(/\bSUM\s*\(([^)]+)\)/gi, (_, args) => {
      const parts = args.split(';').join(',').split(',');
      return `(${parts.join('+')})`;
    });

    // AVG(a, b) / AVERAGE(a, b)
    expr = expr.replace(/\b(AVG|AVERAGE)\s*\(([^)]+)\)/gi, (_, __, args) => {
      const parts = args.split(';').join(',').split(',');
      return `((${parts.join('+')})/${parts.length})`;
    });

    // MIN(a, b, c) -> Math.min(a, b, c)
    expr = expr.replace(/\bMIN\s*\(([^)]+)\)/gi, (_, args) => {
      const parts = args.split(';').join(',');
      return `Math.min(${parts})`;
    });

    // MAX(a, b, c) -> Math.max(a, b, c)
    expr = expr.replace(/\bMAX\s*\(([^)]+)\)/gi, (_, args) => {
      const parts = args.split(';').join(',');
      return `Math.max(${parts})`;
    });

    // ABS(x) -> Math.abs(x)
    expr = expr.replace(/\bABS\s*\(([^)]+)\)/gi, (_, arg) => `Math.abs(${arg})`);

    // SQRT(x) -> Math.sqrt(x)
    expr = expr.replace(/\bSQRT\s*\(([^)]+)\)/gi, (_, arg) => `Math.sqrt(${arg})`);

    // ROUND(x, n) -> Math.round
    expr = expr.replace(/\bROUND\s*\(([^)]+)\)/gi, (_, args) => {
      const parts = args.split(';').join(',').split(',');
      if (parts.length >= 2) {
        const val = parts[0];
        const decimals = parts[1];
        return `(Math.round((${val}) * Math.pow(10, ${decimals})) / Math.pow(10, ${decimals}))`;
      }
      return `Math.round(${parts[0]})`;
    });

    // Convert exponentiation symbol ^ to **
    expr = expr.replace(/\^/g, '**');

    // 3. Security Sanity Check: allow numbers, operators, Math functions, parens, spaces
    const safePattern = /^[0-9\.\+\-\*\/\%\*\*\(\)\sMath\.\w\,]+$/;
    if (!safePattern.test(expr)) {
      return { isFormula: true, result: '#VALUE!', originalFormula, isError: true };
    }

    // 4. Safe Evaluation
    const safeEvaluator = new Function(`"use strict"; return (${expr});`);
    const val = safeEvaluator();

    if (typeof val === 'number') {
      if (isNaN(val) || !isFinite(val)) {
        return { isFormula: true, result: '#DIV/0!', originalFormula, isError: true };
      }
      // Round to 4 decimal places for clean floating point representation
      const cleanVal = Math.round(val * 10000) / 10000;
      return { isFormula: true, result: cleanVal, originalFormula };
    }

    return { isFormula: true, result: val, originalFormula };
  } catch (e) {
    return { isFormula: true, result: '#ERROR!', originalFormula, isError: true };
  }
}

export interface QtyValidationResult {
  isValid: boolean;
  parsedQty: number | '';
  isFormula: boolean;
  errorMessage?: string;
}

/**
 * Validates Qty cell input:
 * Checks if the entered string starts with '=' to treat as formula,
 * otherwise enforcing strict numeric parsing to ensure calculation stability.
 */
export function validateQtyInput(rawValue: any): QtyValidationResult {
  if (rawValue === '' || rawValue === null || rawValue === undefined) {
    return { isValid: true, parsedQty: '', isFormula: false };
  }

  const strVal = String(rawValue).trim();
  if (strVal === '') {
    return { isValid: true, parsedQty: '', isFormula: false };
  }

  // 1. Check if string starts with '=' -> Treat as formula
  if (strVal.startsWith('=')) {
    const evalRes = evaluateExcelFormula(strVal);
    if (evalRes.isError || typeof evalRes.result !== 'number') {
      return {
        isValid: false,
        parsedQty: '',
        isFormula: true,
        errorMessage: `Formula error (${evalRes.result}): Silakan periksa kembali formula yang diinput.`,
      };
    }
    const num = evalRes.result;
    if (isNaN(num) || !isFinite(num)) {
      return {
        isValid: false,
        parsedQty: '',
        isFormula: true,
        errorMessage: 'Formula menghasilkan nilai tidak valid (NaN/Infinity).',
      };
    }
    return {
      isValid: true,
      parsedQty: Math.round(num * 100) / 100,
      isFormula: true,
    };
  }

  // 2. Non-formula input -> Enforce strict numeric parsing (support Indonesian decimal comma)
  const cleanStr = strVal.replace(',', '.');
  const num = parseFloat(cleanStr);

  if (isNaN(num) || !isFinite(num)) {
    return {
      isValid: false,
      parsedQty: '',
      isFormula: false,
      errorMessage: `Input Qty tidak valid ("${strVal}"). Masukkan angka atau formula diawali '='.`,
    };
  }

  if (num < 0) {
    return {
      isValid: false,
      parsedQty: '',
      isFormula: false,
      errorMessage: 'Nilai Qty tidak boleh negatif.',
    };
  }

  return {
    isValid: true,
    parsedQty: Math.round(num * 100) / 100,
    isFormula: false,
  };
}

/**
 * Formats a quantity value to 2 decimal places in Indonesian locale (e.g. 600,00 or 1.250,50).
 */
export function formatQty2Decimal(val: any, isPlaceholder?: boolean): string {
  if (isPlaceholder && (val === undefined || val === null || val === '' || val === 0)) {
    return '';
  }
  if (val === undefined || val === null || val === '') {
    return '';
  }
  const num = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.'));
  if (isNaN(num)) return String(val);
  if (num === 0) return '0,00';
  return num.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

