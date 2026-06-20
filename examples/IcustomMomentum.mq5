//+------------------------------------------------------------------+
//|                                            IcustomMomentum.mq5    |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  An EA that loads the SOURCE custom indicator MomentumSlope via    |
//|  iCustom and trades off its sign:                                 |
//|                                                                  |
//|    handle = iCustom(_Symbol, _Period, "MomentumSlope", InpPeriod);|
//|    CopyBuffer(handle, 0, 0, 1, slope);                           |
//|                                                                  |
//|  Strategy (netting model):                                       |
//|    - slope[0] > +threshold  → up-momentum   → be LONG             |
//|    - slope[0] < -threshold  → down-momentum → be SHORT            |
//|    - in between             → no fresh signal (hold)              |
//|  The EA flips its single position when the momentum sign reverses, |
//|  so it always rides the side the custom indicator points to.      |
//|                                                                  |
//|  The point of this sample is the iCustom path: it must actually   |
//|  LOAD MomentumSlope.mq5 (handle != INVALID_HANDLE), run its       |
//|  OnCalculate, and read its buffer with CopyBuffer (as-series).    |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- inputs
input int    InpPeriod    = 10;     // momentum look-back passed to the indicator
input double InpThreshold = 0.0;    // slope dead-band (price units; 0 = sign only)
input double InpLots      = 0.10;   // trade volume (lots)

//--- globals
int    slopeHandle = INVALID_HANDLE;
CTrade trade;

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   // iCustom resolves "MomentumSlope" → examples/indicators/MomentumSlope.mq5,
   // transpiles it, and returns a handle whose buffer 0 is its slope series.
   slopeHandle = iCustom(_Symbol, _Period, "MomentumSlope", InpPeriod);
   if(slopeHandle == INVALID_HANDLE)
     {
      Print("IcustomMomentum: iCustom(MomentumSlope) failed to load");
      return(INIT_FAILED);
     }
   trade.SetExpertMagicNumber(20240615);
   trade.SetDeviationInPoints(10);
   Print(StringFormat("IcustomMomentum init: handle=%d period=%d thr=%.5f",
                      slopeHandle, InpPeriod, InpThreshold));
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   if(slopeHandle != INVALID_HANDLE)
      IndicatorRelease(slopeHandle);
  }
//+------------------------------------------------------------------+
//| Expert tick                                                      |
//+------------------------------------------------------------------+
void OnTick()
  {
   double slope[];
   ArraySetAsSeries(slope, true);
   // The newest slope value (index 0). Returns < 1 while the indicator is in
   // warm-up (the first N bars have no value N bars back).
   if(CopyBuffer(slopeHandle, 0, 0, 1, slope) < 1)
      return;

   double m = slope[0];

   bool longSignal  = (m >  InpThreshold);
   bool shortSignal = (m < -InpThreshold);

   bool hasPosition = PositionSelect(_Symbol);
   long ptype = hasPosition ? PositionGetInteger(POSITION_TYPE) : -1;

   if(longSignal)
     {
      // Flip a short into a long; open a long if flat.
      if(hasPosition && ptype == POSITION_TYPE_SELL)
        {
         trade.PositionClose(_Symbol);
         hasPosition = false;
        }
      if(!hasPosition)
         if(trade.Buy(InpLots, _Symbol))
            Print(StringFormat("LONG  slope=%s", DoubleToString(m, _Digits)));
     }
   else if(shortSignal)
     {
      if(hasPosition && ptype == POSITION_TYPE_BUY)
        {
         trade.PositionClose(_Symbol);
         hasPosition = false;
        }
      if(!hasPosition)
         if(trade.Sell(InpLots, _Symbol))
            Print(StringFormat("SHORT slope=%s", DoubleToString(m, _Digits)));
     }
  }
//+------------------------------------------------------------------+
