"""Utility functions for downloading and updating prices."""
from __future__ import annotations
import json
import os
import shutil
import time
import requests

def download_url_to_file(url: str, dest_path: str, chunk_size: int = 8192, timeout: int = 10, session: requests.Session|None = None) -> bool:
    """
    Download a URL to a local file using streaming.

    Returns True on success, False on failure.
    """
    os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
    tmp_path = dest_path + ".part"
    close_session = False
    if session is None:
        session = requests.Session()
        close_session = True

    try:
        with session.get(url, stream=True, timeout=timeout) as resp:
            resp.raise_for_status()
            with open(tmp_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=chunk_size):
                    if chunk:
                        f.write(chunk)
        shutil.move(tmp_path, dest_path)
        return True
    except Exception:
        # clean up partial file
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
        return False
    finally:
        if close_session:
            session.close()

PATH='https://poe.ninja/api/data'
LEAGUE='Mirage'
ITEMS=[
    'Scarab',
    'UniqueAccessory',
    'UniqueArmour',
    'UniqueFlask',
    'UniqueJewel',
    'UniqueWeapon',
    'DivinationCard',
]
CURRENCIES=[
    'Currency',
    'Fragment',
]


def fetch_data(endpoint:str,league:str,item:str):
    url= f'{PATH}/{endpoint}?league={league}&type={item}'
    dest_path = f'data/{item}.json'
    if download_url_to_file(url, dest_path):
        print(f'Successfully downloaded {item} data.')

def update_prices():
    for type in ITEMS:
        fetch_data('itemoverview', LEAGUE, type)

    for type in CURRENCIES:
        fetch_data('currencyoverview', LEAGUE, type)
        
def list_currency_prices(name:str,divine_ratio:float=1):
    import json
    with open(f'data/{name}.json', 'r') as f:
        data = json.load(f)
        
    prices={}
    
    for line in data['lines']:
        name=line.get('currencyTypeName')
        val=line['chaosEquivalent']
        if name=='Divine Orb':
            divine_ratio=val
        prices[name]={'chaos': val}

    for name,val in prices.items():
        prices[name]['divine']=round(val['chaos']/divine_ratio,2)
    return prices

def list_item_prices(name:str):
    import json
    with open(f'data/{name}.json', 'r',encoding='utf-8') as f:
        data = json.load(f)
        
    prices={}
    
    for line in data['lines']:
        name=line['name']
        variant=line.get('variant') or ''
        prices[name]={
            'name': name, 
            'variant': variant,
            'basetype': line['baseType'],
            'chaos': line['chaosValue'],
            'divines': line['divineValue'],
            'links': line.get('links', 0),
            }

    return prices

print('Updating prices...')
#update_prices()
currency=list_currency_prices('Currency')

print('Divine ratio:', currency['Divine Orb']['chaos'])

items=[]
for i in ITEMS:
    items.append(list_item_prices(i))

price_db=[]
for item in items:
    for name,vals in item.items():
        price_db.append(vals)

with open('prices.json','w') as f:
    json.dump({
        'date':int(time.time()),
        'currency': currency,
        'items': price_db,
    },f,indent=4)
