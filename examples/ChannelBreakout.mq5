//+------------------------------------------------------------------+
//|                                             ChannelBreakout.mq5   |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  A Donchian-channel BREAKOUT EA using PENDING STOP orders.        |
//|                                                                  |
//|  Strategy (netting model):                                       |
//|    - Track the N-bar channel: highest HIGH and lowest LOW over    |
//|      the last InpChannel COMPLETED bars (iHighest / iLowest on     |
//|      the HIGH / LOW series, started at bar 1 to skip the forming   |
//|      bar).                                                        |
//|    - When FLAT, rest a BUY STOP a buffer above the channel high    |
//|      and a SELL STOP a buffer below the channel low (CTrade.       |
//|      BuyStop / SellStop). A genuine breakout fills one of them.    |
//|    - As the channel drifts, CANCEL & REPLACE the resting stops so  |
//|      they always sit at the live channel edge (CTrade.OrderDelete).|
//|    - Once a stop fills (a position exists), pull BOTH pendings so  |
//|      the EA isn't long-and-pending-short at once; manage the open  |
//|      position with its attached SL/TP and re-arm when flat again.  |
//|                                                                  |
//|  Exercises: iHighest / iLowest, iHigh / iLow, CTrade.BuyStop /     |
//|  SellStop / OrderDelete, OrdersTotal / OrderSelect / OrderGet*,    |
//|  PositionSelect, NormalizeDouble, StringFormat.                   |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- inputs
input int    InpChannel     = 20;     // Donchian channel length (bars)
input double InpBufferPoints = 30.0;  // breakout buffer beyond the edge (points)
input double InpStopPoints   = 200.0; // protective SL distance (points)
input double InpTakePoints   = 400.0; // TP distance (points)
input double InpLots         = 0.10;  // trade volume (lots)
input double InpRetune       = 10.0;  // re-place stops only if edge moved > this (points)

//--- globals
CTrade trade;
double g_buyTrigger  = 0.0;   // last placed BUY STOP price (0 = none)
double g_sellTrigger = 0.0;   // last placed SELL STOP price (0 = none)

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   trade.SetExpertMagicNumber(20240616);
   trade.SetDeviationInPoints(10);
   Print(StringFormat("ChannelBreakout init: channel=%d buffer=%.1fpts",
                      InpChannel, InpBufferPoints));
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Cancel every resting pending order this EA placed.               |
//+------------------------------------------------------------------+
void CancelAllPendings()
  {
   // Walk the pending pool back-to-front (deleting shifts indices).
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0)
         continue;
      trade.OrderDelete(ticket);
     }
   g_buyTrigger  = 0.0;
   g_sellTrigger = 0.0;
  }
//+------------------------------------------------------------------+
//| Expert tick                                                      |
//+------------------------------------------------------------------+
void OnTick()
  {
   double point = _Point;

   // ── If a breakout already filled, manage as a single open position ──
   if(PositionSelect(_Symbol))
     {
      // A stop filled → ensure no stray opposite pending lingers, then let
      // the position run on its attached SL/TP. Re-arm happens once flat.
      if(OrdersTotal() > 0)
         CancelAllPendings();
      return;
     }

   // ── Flat: (re)compute the Donchian channel over completed bars ──
   // Start at as-series index 1 so the still-forming bar 0 is excluded.
   int hiIdx = iHighest(_Symbol, _Period, MODE_HIGH, InpChannel, 1);
   int loIdx = iLowest(_Symbol, _Period, MODE_LOW,  InpChannel, 1);
   if(hiIdx < 0 || loIdx < 0)
      return;   // not enough history yet

   double channelHigh = iHigh(_Symbol, _Period, hiIdx);
   double channelLow  = iLow(_Symbol, _Period, loIdx);
   if(channelHigh <= 0.0 || channelLow <= 0.0)
      return;

   double buffer       = InpBufferPoints * point;
   double buyTrigger   = NormalizeDouble(channelHigh + buffer, _Digits);
   double sellTrigger  = NormalizeDouble(channelLow  - buffer, _Digits);

   // Protective SL/TP, sized in points off the trigger.
   double slDist = InpStopPoints * point;
   double tpDist = InpTakePoints * point;

   double buySl  = NormalizeDouble(buyTrigger  - slDist, _Digits);
   double buyTp  = NormalizeDouble(buyTrigger  + tpDist, _Digits);
   double sellSl = NormalizeDouble(sellTrigger + slDist, _Digits);
   double sellTp = NormalizeDouble(sellTrigger - tpDist, _Digits);

   // ── Cancel & replace only when the channel edge has actually moved ──
   double retune = InpRetune * point;
   bool   needReplace =
      (g_buyTrigger  == 0.0) || (g_sellTrigger == 0.0) ||
      (MathAbs(buyTrigger  - g_buyTrigger)  > retune) ||
      (MathAbs(sellTrigger - g_sellTrigger) > retune);

   if(!needReplace)
      return;   // edges essentially unchanged — leave the resting stops alone

   // Pull the stale stops, then place fresh ones at the live channel edges.
   if(OrdersTotal() > 0)
      CancelAllPendings();

   if(trade.BuyStop(InpLots, buyTrigger, _Symbol, buySl, buyTp, "donchian-up"))
     {
      g_buyTrigger = buyTrigger;
      Print(StringFormat("BUY STOP  @%s (channelHigh=%s)",
                         DoubleToString(buyTrigger, _Digits),
                         DoubleToString(channelHigh, _Digits)));
     }

   if(trade.SellStop(InpLots, sellTrigger, _Symbol, sellSl, sellTp, "donchian-dn"))
     {
      g_sellTrigger = sellTrigger;
      Print(StringFormat("SELL STOP @%s (channelLow=%s)",
                         DoubleToString(sellTrigger, _Digits),
                         DoubleToString(channelLow, _Digits)));
     }
  }
//+------------------------------------------------------------------+
