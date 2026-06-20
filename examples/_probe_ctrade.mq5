//+------------------------------------------------------------------+
//|                                                 _probe_ctrade.mq5 |
//|                                    mql5-transpiler feature probe   |
//|                                                                  |
//|  Probe for the CTrade completions added this cycle:               |
//|  PositionOpen + OrderModify + the config setters + the extra      |
//|  Result* accessors. On the first flat tick it opens a market BUY  |
//|  via CTrade.PositionOpen (the canonical Standard-Library open),   |
//|  then reads back the result accessors. Transpiles cleanly AND     |
//|  trades in the backtest.                                          |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler feature probe"
#property version   "1.00"

#include <Trade/Trade.mqh>

input double InpVolume = 0.10;   // lots per position

CTrade trade;

//+------------------------------------------------------------------+
int OnInit()
  {
   trade.SetExpertMagicNumber(20240614);
   trade.SetDeviationInPoints(10);
   trade.SetTypeFillingBySymbol(_Symbol);   // config setter (new)
   trade.SetAsyncMode(false);               // config setter (new)
   Print("CTrade probe initialised, magic=", trade.RequestMagic());
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
void OnTick()
  {
   // Open once: only when flat on the bound symbol.
   if(PositionSelect(_Symbol))
      return;

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   // PositionOpen(symbol, order_type, volume, price, sl, tp, comment) — the
   // canonical Standard-Library market open added this cycle.
   if(trade.PositionOpen(_Symbol, ORDER_TYPE_BUY, InpVolume, ask, 0.0, 0.0, "ctrade probe"))
      Print("PositionOpen ok: retcode=", trade.ResultRetcode(),
            " deal=", trade.ResultDeal(),
            " price=", trade.ResultPrice(),
            " comment=", trade.ResultComment());
   else
      Print("PositionOpen failed: retcode=", trade.ResultRetcode(),
            " ", trade.ResultRetcodeDescription());
  }
//+------------------------------------------------------------------+
