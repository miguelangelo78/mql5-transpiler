//+------------------------------------------------------------------+
//|                                              OpenCloseBtc.mq5     |
//|                                       mql5-transpiler example     |
//|                                                                  |
//|  Opens a market position on the chart symbol, holds it for a     |
//|  fixed number of seconds, then closes it — a minimal, observable |
//|  live-trade demo (open → wait → close) driven by OnTimer.        |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler example"
#property version   "1.00"

#include <Trade/Trade.mqh>

input double InpLots        = 0.01;   // Volume to open (lots)
input int    InpHoldSeconds = 10;     // How long to hold before closing

CTrade trade;

//+------------------------------------------------------------------+
int OnInit()
  {
   PrintFormat("OpenCloseBtc: opening %.2f %s …", InpLots, _Symbol);
   if(!trade.Buy(InpLots, _Symbol))
     {
      PrintFormat("  OPEN FAILED — retcode %d", trade.ResultRetcode());
      return(INIT_FAILED);
     }
   PrintFormat("  opened: deal=%d price=%.2f retcode=%d",
               (int)trade.ResultDeal(), trade.ResultPrice(), trade.ResultRetcode());

   // Fire OnTimer once after InpHoldSeconds to close the position.
   EventSetTimer(InpHoldSeconds);
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
void OnTimer()
  {
   EventKillTimer();
   if(PositionSelect(_Symbol))
     {
      PrintFormat("OpenCloseBtc: %d s elapsed — closing %s …", InpHoldSeconds, _Symbol);
      if(trade.PositionClose(_Symbol))
         PrintFormat("  closed: retcode=%d", trade.ResultRetcode());
      else
         PrintFormat("  CLOSE FAILED — retcode %d", trade.ResultRetcode());
     }
   else
      Print("OpenCloseBtc: no position to close");
  }
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   // Safety: never leave the position open if the timer didn't fire.
   if(PositionSelect(_Symbol))
     {
      Print("OpenCloseBtc: closing on deinit (safety)");
      trade.PositionClose(_Symbol);
     }
  }
//+------------------------------------------------------------------+
