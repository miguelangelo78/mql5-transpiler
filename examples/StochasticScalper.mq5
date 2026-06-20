//+------------------------------------------------------------------+
//|                                          StochasticScalper.mq5    |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  A Stochastic-oscillator momentum scalper.                       |
//|                                                                  |
//|  The Stochastic %K/%D pair is a fast oscillator: %K is the raw    |
//|  position of price within its recent high-low range, %D is its    |
//|  moving average. A %K-over-%D cross from an OVERSOLD zone is an    |
//|  early "turning up" signal; the mirror from OVERBOUGHT is a       |
//|  "turning down" signal.                                          |
//|                                                                  |
//|  Strategy (netting model, flips on the opposite signal):         |
//|    BUY  when %K crosses ABOVE %D while BOTH are below the         |
//|         oversold level (a snap-back from the bottom).            |
//|    SELL when %K crosses BELOW %D while BOTH are above the         |
//|         overbought level (a roll-over from the top).            |
//|    An opposite cross closes the running position and opens the   |
//|    new side, so the EA is always aligned with the latest turn.   |
//|                                                                  |
//|  Exercises: iStochastic(K,D,slow) with %K via CopyBuffer buffer   |
//|  0 and %D via buffer 1 (two samples each, to detect a cross),    |
//|  CTrade Buy/Sell/PositionClose, the netting-position read.       |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- inputs
input int    InpKPeriod   = 5;       // Stochastic %K period
input int    InpDPeriod   = 3;       // Stochastic %D period (signal)
input int    InpSlowing   = 3;       // Stochastic slowing
input double InpOversold  = 20.0;    // Oversold zone (buy below)
input double InpOverbought = 80.0;   // Overbought zone (sell above)
input int    InpAtrPeriod = 14;      // ATR period (sizes the SL/TP bracket)
input double InpTpAtrMult = 3.0;     // Take-profit distance (ATRs)
input double InpSlAtrMult = 2.0;     // Stop-loss distance (ATRs)
input double InpLots      = 0.10;    // Trade volume (lots)

//--- globals
int    stochHandle = INVALID_HANDLE;
int    atrHandle   = INVALID_HANDLE;
CTrade trade;

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   stochHandle = iStochastic(_Symbol, _Period, InpKPeriod, InpDPeriod,
                             InpSlowing, MODE_SMA, 0);
   atrHandle   = iATR(_Symbol, _Period, InpAtrPeriod);

   if(stochHandle == INVALID_HANDLE || atrHandle == INVALID_HANDLE)
     {
      Print("StochasticScalper: failed to create indicator handles");
      return(INIT_FAILED);
     }

   trade.SetExpertMagicNumber(20240501);
   Print(StringFormat("StochasticScalper init: stoch(%d,%d,%d) OS<%.0f OB>%.0f",
                      InpKPeriod, InpDPeriod, InpSlowing,
                      InpOversold, InpOverbought));
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   IndicatorRelease(stochHandle);
   IndicatorRelease(atrHandle);
  }
//+------------------------------------------------------------------+
//| Expert tick                                                      |
//+------------------------------------------------------------------+
void OnTick()
  {
   double k[];   // %K (main line)
   double d[];   // %D (signal line)
   double atr[]; // ATR (sizes the bracket to live volatility)

   ArraySetAsSeries(k, true);
   ArraySetAsSeries(d, true);
   ArraySetAsSeries(atr, true);

   // Two samples each (index 0 = newest, 1 = prior bar) to detect a cross.
   if(CopyBuffer(stochHandle, 0, 0, 2, k) < 2) return;   // buffer 0 = %K
   if(CopyBuffer(stochHandle, 1, 0, 2, d) < 2) return;   // buffer 1 = %D
   if(CopyBuffer(atrHandle,   0, 0, 1, atr) < 1) return;

   // %K / %D cross detection.
   bool crossUp   = (k[1] <= d[1]) && (k[0] > d[0]);
   bool crossDown = (k[1] >= d[1]) && (k[0] < d[0]);

   // Zone filter: the cross must originate from the extreme, on BOTH the
   // prior and current sample (a genuine reversal, not mid-range noise).
   bool fromOversold   = (k[1] < InpOversold)   && (d[1] < InpOversold);
   bool fromOverbought = (k[1] > InpOverbought) && (d[1] > InpOverbought);

   bool buySignal  = crossUp   && fromOversold;
   bool sellSignal = crossDown && fromOverbought;

   bool hasPosition = PositionSelect(_Symbol);
   long ptype       = hasPosition ? PositionGetInteger(POSITION_TYPE) : -1;

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double tp  = InpTpAtrMult * atr[0];   // a quick scalp target (ATR-sized)
   double sl  = InpSlAtrMult * atr[0];   // capped risk if the bounce fails

   if(buySignal)
     {
      // Close a running short, then open the long if flat. The bracket banks a
      // quick bounce off the oversold extreme rather than holding to the next
      // opposite cross.
      if(hasPosition && ptype == POSITION_TYPE_SELL)
        {
         trade.PositionClose(_Symbol);
         hasPosition = false;
        }
      if(!hasPosition)
        {
         double slp = NormalizeDouble(bid - sl, _Digits);
         double tpp = NormalizeDouble(bid + tp, _Digits);
         if(trade.Buy(InpLots, _Symbol, 0.0, slp, tpp))
            Print(StringFormat("BUY  k=%s d=%s (oversold cross up)",
                               DoubleToString(k[0], 1), DoubleToString(d[0], 1)));
        }
     }
   else if(sellSignal)
     {
      // Close a running long, then open the short if flat.
      if(hasPosition && ptype == POSITION_TYPE_BUY)
        {
         trade.PositionClose(_Symbol);
         hasPosition = false;
        }
      if(!hasPosition)
        {
         double slp = NormalizeDouble(bid + sl, _Digits);
         double tpp = NormalizeDouble(bid - tp, _Digits);
         if(trade.Sell(InpLots, _Symbol, 0.0, slp, tpp))
            Print(StringFormat("SELL k=%s d=%s (overbought cross down)",
                               DoubleToString(k[0], 1), DoubleToString(d[0], 1)));
        }
     }
  }
//+------------------------------------------------------------------+
