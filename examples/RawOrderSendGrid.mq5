//+------------------------------------------------------------------+
//|                                            RawOrderSendGrid.mq5   |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  A long-side GRID built on the RAW trade API — MqlTradeRequest /   |
//|  MqlTradeResult + OrderSend — with NO CTrade wrapper at all. It    |
//|  demonstrates the low-level MT5 primitive end-to-end.             |
//|                                                                  |
//|  Strategy (netting model):                                       |
//|    On the first flat tick, seed the grid:                        |
//|      1. a MARKET BUY at the ask (TRADE_ACTION_DEAL),              |
//|      2. a ladder of BUY LIMIT orders InpStepPoints apart BELOW    |
//|         the entry (TRADE_ACTION_PENDING / ORDER_TYPE_BUY_LIMIT),  |
//|         so deeper dips average the position down.                 |
//|    Each level carries the same shared TP above the entry; when    |
//|    price rallies to the TP the whole averaged position closes and |
//|    the grid is flat again, ready to re-seed.                      |
//|                                                                  |
//|  Exercises: MqlTradeRequest / MqlTradeResult zero-init + field    |
//|  assignment, OrderSend market (TRADE_ACTION_DEAL) AND pending     |
//|  (TRADE_ACTION_PENDING) actions, the result struct read-back,     |
//|  PositionSelect / OrdersTotal guards, NormalizeDouble.            |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property strict

//--- inputs
input double InpLots       = 0.10;   // lots per grid level
input int    InpLevels     = 4;      // number of BUY LIMIT rungs below entry
input double InpStepPoints = 150.0;  // spacing between rungs (points)
input double InpTakePoints = 300.0;  // shared TP above the market entry (points)

//+------------------------------------------------------------------+
//| Send ONE order via the raw API; returns true on a success retcode.|
//| `type` is ORDER_TYPE_BUY (market) or ORDER_TYPE_BUY_LIMIT (rung). |
//+------------------------------------------------------------------+
bool SendOrder(int action, int type, double price, double tp, string tag)
  {
   MqlTradeRequest request;
   MqlTradeResult  result;

   request.action    = action;       // TRADE_ACTION_DEAL or TRADE_ACTION_PENDING
   request.symbol    = _Symbol;
   request.volume    = InpLots;
   request.type      = type;
   request.price     = NormalizeDouble(price, _Digits);
   request.tp        = NormalizeDouble(tp, _Digits);
   request.deviation = 10;
   request.magic     = 20240617;
   request.comment   = tag;

   if(OrderSend(request, result))
     {
      Print(StringFormat("%s ok: retcode=%d order=%I64u deal=%I64u @%s",
                         tag, result.retcode, result.order, result.deal,
                         DoubleToString(request.price, _Digits)));
      return(true);
     }
   Print(StringFormat("%s FAILED: retcode=%d %s", tag, result.retcode, result.comment));
   return(false);
  }
//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   Print(StringFormat("RawOrderSendGrid init: levels=%d step=%.1fpts tp=%.1fpts",
                      InpLevels, InpStepPoints, InpTakePoints));
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert tick                                                      |
//+------------------------------------------------------------------+
void OnTick()
  {
   // Re-seed the grid only when fully flat: no open position AND no resting
   // pending rungs. While the grid is live the position/pendings manage
   // themselves via the shared TP.
   if(PositionSelect(_Symbol))
      return;
   if(OrdersTotal() > 0)
      return;

   double point = _Point;
   double ask   = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   if(ask <= 0.0)
      return;

   double step = InpStepPoints * point;
   double tp   = ask + InpTakePoints * point;   // shared TP above the entry

   // 1) The anchor: a MARKET BUY at the ask.
   if(!SendOrder(TRADE_ACTION_DEAL, ORDER_TYPE_BUY, ask, tp, "grid-market"))
      return;   // if the anchor didn't open, don't lay the ladder

   // 2) The ladder: BUY LIMIT rungs stepping DOWN from the entry. Each deeper
   //    fill averages the position lower; all share the same TP.
   for(int level = 1; level <= InpLevels; level++)
     {
      double rungPrice = ask - step * level;
      if(rungPrice <= 0.0)
         break;
      string tag = StringFormat("grid-limit-%d", level);
      SendOrder(TRADE_ACTION_PENDING, ORDER_TYPE_BUY_LIMIT, rungPrice, tp, tag);
     }
  }
//+------------------------------------------------------------------+
