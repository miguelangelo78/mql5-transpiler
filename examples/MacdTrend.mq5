//+------------------------------------------------------------------+
//|                                                MacdTrend.mq5      |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  A MACD(12,26,9) TREND FOLLOWER.                                 |
//|   - Goes LONG  when the MACD main line crosses ABOVE its signal. |
//|   - Goes SHORT when the MACD main line crosses BELOW its signal. |
//|   - Flips the position on the opposite cross (netting model):    |
//|     a long signal closes any short and opens a long, and vice    |
//|     versa, so the EA is always aligned with the latest momentum  |
//|     trend.                                                       |
//|                                                                  |
//|  Exercises: iMACD (MAIN=buffer 0, SIGNAL=buffer 1 via CopyBuffer),|
//|  CTrade Buy/Sell/PositionClose, the netting position model.      |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- inputs
input int    InpFastEma   = 12;     // MACD fast EMA period
input int    InpSlowEma   = 26;     // MACD slow EMA period
input int    InpSignalSma = 9;      // MACD signal SMA period
input double InpLots      = 0.10;   // Trade volume (lots)

//--- globals
int    macdHandle = INVALID_HANDLE;
CTrade trade;

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   macdHandle = iMACD(_Symbol, _Period, InpFastEma, InpSlowEma, InpSignalSma, PRICE_CLOSE);

   if(macdHandle == INVALID_HANDLE)
     {
      Print("MacdTrend: failed to create MACD handle");
      return(INIT_FAILED);
     }

   Print("MacdTrend initialised: macd(", InpFastEma, ",", InpSlowEma, ",", InpSignalSma, ")");
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   IndicatorRelease(macdHandle);
  }
//+------------------------------------------------------------------+
//| Expert tick                                                      |
//+------------------------------------------------------------------+
void OnTick()
  {
   double macdMain[];
   double macdSig[];
   ArraySetAsSeries(macdMain, true);
   ArraySetAsSeries(macdSig, true);

   // Two samples (0 = newest bar, 1 = prior bar) of each line to detect a cross.
   if(CopyBuffer(macdHandle, 0, 0, 2, macdMain) < 2)
      return;
   if(CopyBuffer(macdHandle, 1, 0, 2, macdSig) < 2)
      return;

   bool crossUp   = (macdMain[1] <= macdSig[1]) && (macdMain[0] > macdSig[0]);
   bool crossDown = (macdMain[1] >= macdSig[1]) && (macdMain[0] < macdSig[0]);

   bool hasPosition = PositionSelect(_Symbol);
   long ptype = hasPosition ? PositionGetInteger(POSITION_TYPE) : -1;

   if(crossUp)
     {
      // Momentum turned up — flip any short, then go long if flat.
      if(hasPosition && ptype == POSITION_TYPE_SELL)
        {
         trade.PositionClose(_Symbol);
         hasPosition = false;
        }
      if(!hasPosition)
         trade.Buy(InpLots, _Symbol);
     }
   else if(crossDown)
     {
      // Momentum turned down — flip any long, then go short if flat.
      if(hasPosition && ptype == POSITION_TYPE_BUY)
        {
         trade.PositionClose(_Symbol);
         hasPosition = false;
        }
      if(!hasPosition)
         trade.Sell(InpLots, _Symbol);
     }
  }
//+------------------------------------------------------------------+
