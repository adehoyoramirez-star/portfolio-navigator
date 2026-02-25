import React, { useState, useRef, useEffect, useCallback } from 'react';
import { MarketData } from '@/lib/portfolio';
import { MacroExtendedData } from '@/lib/macroExtended';

interface MarketGaugesProps {
  marketData: MarketData;
  macroExtended: MacroExtendedData | null;
  tnx: number;
  onMacroChange?: (newMacro: MacroExtendedData) => void;
}

export const MarketGauges: React.FC<MarketGaugesProps> = ({
  marketData,
  macroExtended,
  tnx,
  onMacroChange
}) => {
  const { vix, tnx: tnxFromData, irx, btcZScore } = marketData;
  const tedSpread = tnxFromData - irx;

  const timeoutsRef = useRef<{ per?: NodeJS.Timeout; m2?: NodeJS.Timeout }>({});

  useEffect(() => {
    return () => {
      if (timeoutsRef.current.per) clearTimeout(timeoutsRef.current.per);
      if (timeoutsRef.current.m2) clearTimeout(timeoutsRef.current.m2);
    };
  }, []);

  const [editingPER, setEditingPER] = useState(false);
  const [editingM2, setEditingM2] = useState(false);
  const [perInput, setPerInput] = useState(() => macroExtended?.erp?.toString() ?? '22');
  const [m2Input, setM2Input] = useState(() => macroExtended?.m2Growth?.toString() ?? '5.2');

  useEffect(() => {
    setPerInput(macroExtended?.erp?.toString() ?? '22');
    setM2Input(macroExtended?.m2Growth?.toString() ?? '5.2');
  }, [macroExtended]);

  const per = macroExtended?.erp ?? 22;
  const earningsYield = 1 / per;
  const riskFree = typeof tnx === 'number' && !isNaN(tnx) ? tnx / 100 : 0.04;
  const erpValue = ((earningsYield - riskFree) * 100).toFixed(1);
  const m2Growth = macroExtended?.m2Growth?.toFixed(1) ?? '5.2';

  const handlePERSubmit = useCallback(() => {
    try {
      const newPER = parseFloat(perInput);
      if (isNaN(newPER) || newPER <= 0) return;
      if (onMacroChange) {
        onMacroChange({ erp: newPER, m2Growth: macroExtended?.m2Growth ?? 5.2 });
      }
      setEditingPER(false);
    } catch (error) {
      console.error(error);
      setEditingPER(false);
    }
  }, [perInput, onMacroChange, macroExtended]);

  const handleM2Submit = useCallback(() => {
    try {
      const newM2 = parseFloat(m2Input);
      if (isNaN(newM2)) return;
      if (onMacroChange) {
        onMacroChange({ erp: macroExtended?.erp ?? 22, m2Growth: newM2 });
      }
      setEditingM2(false);
    } catch (error) {
      console.error(error);
      setEditingM2(false);
    }
  }, [m2Input, onMacroChange, macroExtended]);

  const handlePERClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (timeoutsRef.current.per) clearTimeout(timeoutsRef.current.per);
    timeoutsRef.current.per = setTimeout(() => setEditingPER(true), 0);
  }, []);

  const handleM2Click = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (timeoutsRef.current.m2) clearTimeout(timeoutsRef.current.m2);
    timeoutsRef.current.m2 = setTimeout(() => setEditingM2(true), 0);
  }, []);

  const cancelPER = useCallback(() => {
    setEditingPER(false);
    setPerInput(macroExtended?.erp?.toString() ?? '22');
  }, [macroExtended]);

  const cancelM2 = useCallback(() => {
    setEditingM2(false);
    setM2Input(macroExtended?.m2Growth?.toString() ?? '5.2');
  }, [macroExtended]);

  const getVixColor = (v: number) => v < 20 ? 'text-green-400' : v < 30 ? 'text-yellow-400' : 'text-red-400';
  const getTedColor = (s: number) => s < 0 ? 'text-red-400' : s < 1 ? 'text-yellow-400' : 'text-green-400';
  const getRateColor = (r: number) => r < 2 ? 'text-green-400' : r < 4 ? 'text-yellow-400' : 'text-red-400';
  const getZColor = (z: number) => (z < -2 || z > 2) ? 'text-red-400' : (z < -1 || z > 1) ? 'text-yellow-400' : 'text-green-400';
  const getErpColor = (erp: number) => erp > 2 ? 'text-green-400' : erp > 0 ? 'text-yellow-400' : 'text-red-400';
  const getM2Color = (m2: number) => m2 > 5 ? 'text-green-400' : m2 > 2 ? 'text-yellow-400' : 'text-red-400';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-gray-800 p-4 rounded-lg shadow text-center">
          <div className="text-sm text-gray-400">VIX</div>
          <div className={`text-2xl font-bold ${getVixColor(vix)}`}>{vix.toFixed(1)}</div>
        </div>
        <div className="bg-gray-800 p-4 rounded-lg shadow text-center">
          <div className="text-sm text-gray-400">Curva 10y-3m</div>
          <div className={`text-2xl font-bold ${getTedColor(tedSpread)}`}>
            {(tedSpread * 100).toFixed(0)} pb
          </div>
        </div>
        <div className="bg-gray-800 p-4 rounded-lg shadow text-center">
          <div className="text-sm text-gray-400">Tipo 10 años</div>
          <div className={`text-2xl font-bold ${getRateColor(tnxFromData)}`}>{tnxFromData.toFixed(1)}%</div>
        </div>
        <div className="bg-gray-800 p-4 rounded-lg shadow text-center">
          <div className="text-sm text-gray-400">Z-score BTC</div>
          <div className={`text-2xl font-bold ${getZColor(btcZScore)}`}>{btcZScore.toFixed(2)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-gray-800 p-4 rounded-lg shadow text-center relative">
          <div className="text-sm text-gray-400">ERP (Equity Risk Premium)</div>
          {editingPER ? (
            <div className="flex items-center justify-center gap-2 mt-1">
              <input
                type="number"
                value={perInput}
                onChange={(e) => setPerInput(e.target.value)}
                className="w-20 p-1 text-black rounded"
                step="0.1"
                min="1"
                autoFocus
              />
              <button onClick={handlePERSubmit} className="bg-blue-600 text-white px-2 py-1 rounded text-xs">OK</button>
              <button onClick={cancelPER} className="bg-gray-600 text-white px-2 py-1 rounded text-xs">Cancel</button>
            </div>
          ) : (
            <div
              className={`text-2xl font-bold ${getErpColor(parseFloat(erpValue))} cursor-pointer hover:opacity-80`}
              onClick={handlePERClick}
              title="Haz clic para editar el PER"
            >
              {erpValue}%
            </div>
          )}
          <div className="text-xs text-gray-500">(1/PER) - 10y</div>
          <div className="text-xs text-gray-400 mt-1">PER: {per}</div>
        </div>

        <div className="bg-gray-800 p-4 rounded-lg shadow text-center">
          <div className="text-sm text-gray-400">M2 Crecimiento anual</div>
          {editingM2 ? (
            <div className="flex items-center justify-center gap-2 mt-1">
              <input
                type="number"
                value={m2Input}
                onChange={(e) => setM2Input(e.target.value)}
                className="w-20 p-1 text-black rounded"
                step="0.1"
                min="-10"
                max="20"
                autoFocus
              />
              <button onClick={handleM2Submit} className="bg-blue-600 text-white px-2 py-1 rounded text-xs">OK</button>
              <button onClick={cancelM2} className="bg-gray-600 text-white px-2 py-1 rounded text-xs">Cancel</button>
            </div>
          ) : (
            <div
              className={`text-2xl font-bold ${getM2Color(parseFloat(m2Growth))} cursor-pointer hover:opacity-80`}
              onClick={handleM2Click}
              title="Haz clic para editar M2"
            >
              {m2Growth}%
            </div>
          )}
          <div className="text-xs text-gray-500">Oferta monetaria</div>
        </div>
      </div>
    </div>
  );
};