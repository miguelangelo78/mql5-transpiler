//+------------------------------------------------------------------+
//|                                              RsiReversal.mq5      |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  RSI mean-reversion with ATR-based risk and pending limit        |
//|  entries, managed on a timer.                                   |
//|   - RSI oversold   -> rest a BUY  LIMIT below price (ATR offset), |
//|                       SL/TP sized in ATRs.                       |
//|   - RSI overbought -> rest a SELL LIMIT above price.            |
//|   - A resting pending whose RSI signal has neutralised is killed. |
//|   - All management happens in OnTimer (not every tick).         |
//|                                                                  |
//|  Exercises (vs the 1st sample): Wilder iRSI + iATR, pending       |
//|  limit orders with SL/TP, OnTimer + EventSetTimer, OrderDelete.   |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"

#include <Trade/Trade.mqh>

//--- inputs
input int    InpRsiPeriod    = 14;     // RSI period (Wilder)
input double InpOversold     = 30.0;   // RSI oversold level
input double InpOverbought   = 70.0;   // RSI overbought level
input int    InpAtrPeriod    = 14;     // ATR period (Wilder)
input double InpEntryAtrMult = 0.5;    // Entry offset (ATRs from price)
input double InpSlAtrMult    = 1.5;    // Stop-loss distance (ATRs)
input double InpTpAtrMult     = 2.0;   // Take-profit distance (ATRs)
input double InpLots         = 0.10;   // Trade volume (lots)
input int    InpTimerSeconds = 60;     // Management timer (seconds)

//--- globals
int    rsiHandle = INVALID_HANDLE;
int    atrHandle = INVALID_HANDLE;
ulong  pendingTicket = 0;
CTrade trade;

//+------------------------------------------------------------------+
int OnInit()
  {
   rsiHandle = iRSI(_Symbol, _Period, InpRsiPeriod, PRICE_CLOSE);
   atrHandle = iATR(_Symbol, _Period, InpAtrPeriod);

   if(rsiHandle == INVALID_HANDLE || atrHandle == INVALID_HANDLE)
     {
      Print("Failed to create indicator handles");
      return(INIT_FAILED);
     }

   EventSetTimer(InpTimerSeconds);
   Print("RsiReversal initialised: rsi=", InpRsiPeriod, " atr=", InpAtrPeriod);
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   IndicatorRelease(rsiHandle);
   IndicatorRelease(atrHandle);
  }
//+------------------------------------------------------------------+
void OnTimer()
  {
   double rsi[];
   double atr[];
   ArraySetAsSeries(rsi, true);
   ArraySetAsSeries(atr, true);

   if(CopyBuffer(rsiHandle, 0, 0, 1, rsi) < 1)
      return;
   if(CopyBuffer(atrHandle, 0, 0, 1, atr) < 1)
      return;

   double a   = atr[0];
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   bool hasPosition = PositionSelect(_Symbol);

   // A position has opened (the pending filled) — stop tracking the pending.
   if(hasPosition)
      pendingTicket = 0;

   // Cancel a resting pending whose RSI signal has neutralised.
   if(pendingTicket != 0 && rsi[0] >= InpOversold && rsi[0] <= InpOverbought)
     {
      trade.OrderDelete(pendingTicket);
      pendingTicket = 0;
     }

   // Seek a new entry only when flat and with no pending working.
   if(!hasPosition && pendingTicket == 0)
     {
      if(rsi[0] < InpOversold)
        {
         double entry = bid - InpEntryAtrMult * a;
         double sl    = entry - InpSlAtrMult * a;
         double tp    = entry + InpTpAtrMult * a;
         if(trade.BuyLimit(InpLots, entry, _Symbol, sl, tp))
            pendingTicket = trade.ResultOrder();
        }
      else if(rsi[0] > InpOverbought)
        {
         double entry = bid + InpEntryAtrMult * a;
         double sl    = entry + InpSlAtrMult * a;
         double tp    = entry - InpTpAtrMult * a;
         if(trade.SellLimit(InpLots, entry, _Symbol, sl, tp))
            pendingTicket = trade.ResultOrder();
        }
     }
  }
//+------------------------------------------------------------------+
