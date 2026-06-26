import io, os
os.environ['PYTHONIOENCODING'] = 'utf-8'
NL = chr(10)
p = 'src/dashboard/InstitutionalDashboard.tsx'
s = io.open(p, 'r', encoding='utf-8').read()
changes = 0

# 1. Remove cashReserveManager import block (L97-106)
old_import = 'import {\n  buildCashReserveState,\n  createBTCLimitOrder,\n  markOrderFilled,\n  cancelOrder,\n  diagnoseCashState,\n  type BTCLimitOrder,\n  type CashReserveState,\n  type CashDiagnostic,\n} from "@/core/dca/cashReserveManager";'
if old_import in s:
    s = s.replace(old_import + NL, '')
    changes += 1
    print('Removed cashReserveManager import')
else:
    print('WARN: import block not found')

# 2. Remove BTC state section (transferAmount, btcLimitOrders, operationalBuffer, newOrder*)
old_state = '  const [transferAmount, setTransferAmount] = useState<number>(0);\n  // \u2500\u2500 Cash Reserve Manager: BTC limit orders + operational buffer \u2500\u2500\n  const [btcLimitOrders, setBtcLimitOrders] = useState<BTCLimitOrder[]>(() => {\n    try { return JSON.parse(localStorage.getItem(\'olympus_btc_orders\') ?? \'[]\'); } catch { return []; }\n  });\n  const [operationalBuffer, setOperationalBuffer] = useState<number>(() => {\n    try { return parseFloat(localStorage.getItem(\'olympus_op_buffer\') ?? \'350\') || 350; } catch { return 350; }\n  });\n  const [newOrderPrice, setNewOrderPrice] = useState<number>(50000);\n  const [newOrderAmount, setNewOrderAmount] = useState<number>(400);\n  const [newOrderLevel, setNewOrderLevel] = useState<1 | 2 | 3 | 4>(3);\n  const [newOrderNotes, setNewOrderNotes] = useState<string>(\'\');'
if old_state in s:
    new_state = '  const [transferAmount, setTransferAmount] = useState<number>(0);'
    s = s.replace(old_state, new_state, 1)
    changes += 1
    print('Removed BTC state declarations')
else:
    print('WARN: BTC state block not found')

# 3. Remove handlers (handleCreateOrder, handleMarkFilled, handleCancelOrder)
old_handlers = '  // \u2500\u2500 Handlers for BTC limit orders \u2500\u2500\n  const handleCreateOrder = () => {\n    if (newOrderPrice <= 0 || newOrderAmount <= 0) return;\n    const order = createBTCLimitOrder(newOrderLevel, newOrderPrice, newOrderAmount, newOrderNotes || undefined);\n    setBtcLimitOrders(prev => [order, ...prev]);\n    setNewOrderPrice(50000);\n    setNewOrderAmount(400);\n    setNewOrderLevel(3);\n    setNewOrderNotes(\'\');\n  };\n  const handleMarkFilled = (orderId: string, fillPrice: number) => {\n    setBtcLimitOrders(prev => markOrderFilled(prev, orderId, fillPrice));\n  };\n  const handleCancelOrder = (orderId: string) => {\n    setBtcLimitOrders(prev => cancelOrder(prev, orderId));\n  };'
if old_handlers in s:
    s = s.replace(old_handlers + NL + NL, '', 1)
    changes += 1
    print('Removed BTC handlers')
else:
    print('WARN: handlers block not found')

# 4. Fix cashState + olympusAvailableCash + cashDiagnostic
old_cashstate = '    // CASH-RESERVE-MANAGER: cash model con BTC orders + operational buffer\n  const cashState = useMemo(() => buildCashReserveState(\n    cashReserve,\n    btcLimitOrders,\n    0,\n    operationalBuffer,\n  ), [cashReserve, btcLimitOrders, operationalBuffer]);\n  const olympusAvailableCash = cashState.freeCash;\n  const tacticalAvailableCash = defensiveLiquidity; // solo se activa en ATTACK\u22654/7'
if old_cashstate in s:
    new_cashstate = '  const olympusAvailableCash = cashReserve;\n  const tacticalAvailableCash = defensiveLiquidity; // solo se activa en ATTACK >= 4/7'
    s = s.replace(old_cashstate, new_cashstate, 1)
    changes += 1
    print('Simplified cashState -> cashReserve')
else:
    print('WARN: cashState block not found')

# 5. Remove cashDiagnostic
old_diag = '  // Cash diagnostic\n  const cashDiagnostic = useMemo(() => diagnoseCashState(cashState), [cashState]);'
if old_diag in s:
    s = s.replace(old_diag + NL + NL, '', 1)
    changes += 1
    print('Removed cashDiagnostic')
else:
    print('WARN: cashDiagnostic not found')

# 6. Remove persist useEffect for btcLimitOrders and operationalBuffer
old_persist = '  // \u2500\u2500 Persist BTC limit orders \u2500\u2500\n  useEffect(() => {\n    try { localStorage.setItem(\'olympus_btc_orders\', JSON.stringify(btcLimitOrders)); } catch { /* silencio */ }\n  }, [btcLimitOrders]);\n  useEffect(() => {\n    try { localStorage.setItem(\'olympus_op_buffer\', String(operationalBuffer)); } catch { /* silencio */ }\n  }, [operationalBuffer]);'
if old_persist in s:
    s = s.replace(old_persist + NL, '')
    changes += 1
    print('Removed BTC persist useEffects')
else:
    print('WARN: persist effects not found')

# 7. Remove Cash Reserve Manager JSX panel (L3097-L3301)
# Find boundaries by searching for the markers
lines = s.split(NL)
start_idx = None
end_idx = None
for i, line in enumerate(lines):
    if 'CASH-RESERVE-MANAGER: Panel completo de liquidez' in line:
        start_idx = i
    if start_idx is not None and i > start_idx and 'Pesos del Portfolio' in line:
        end_idx = i
        break

if start_idx is not None and end_idx is not None:
    old_jsx = NL.join(lines[start_idx:end_idx])
    # Replace with empty (just keep the next section)
    s = s.replace(old_jsx + NL, '')
    changes += 1
    print(f'Removed Cash Reserve Manager JSX (L{start_idx+1}-L{end_idx})')
else:
    print(f'WARN: JSX boundaries not found: start={start_idx}, end={end_idx}')

# 8. Write back
io.open(p, 'w', encoding='utf-8').write(s)
new_lines = len(s.split(NL))
print(f'Done: {changes} changes applied, {new_lines} lines')
